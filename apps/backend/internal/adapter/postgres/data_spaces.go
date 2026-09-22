package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/domain"
	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/observability"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const sandboxGenerationLock = "sewa-motor-sandbox-generation"

func (s *Store) ActiveDataSpace(ctx context.Context, tenantID uuid.UUID, mode domain.DataMode) (domain.DataSpace, error) {
	defer observability.StartSegment(ctx, "Postgres.ActiveDataSpace")()
	if !mode.Valid() {
		return domain.DataSpace{}, domain.Validation("Mode operasi tidak valid", map[string]any{"field": "mode"})
	}
	if tenantID == uuid.Nil {
		return domain.DataSpace{}, domain.NewError(domain.CodeForbidden, "Pilih usaha untuk melanjutkan")
	}
	space, err := dataSpaceByQuery(ctx, s.Pool, `tenant_id = $1 AND mode = $2 AND status = 'active'`, tenantID, mode)
	return space, dbError(err, "find active data space")
}

func (s *Store) DataSpaceByID(ctx context.Context, tenantID, id uuid.UUID) (domain.DataSpace, error) {
	defer observability.StartSegment(ctx, "Postgres.DataSpaceByID")()
	space, err := dataSpaceByQuery(ctx, s.Pool, `tenant_id = $1 AND id = $2`, tenantID, id)
	return space, dbError(err, "find data space")
}

func dataSpaceByQuery(ctx context.Context, query rowQuerier, predicate string, values ...any) (domain.DataSpace, error) {
	defer observability.StartSegment(ctx, "Postgres.dataSpaceByQuery")()
	var space domain.DataSpace
	err := query.QueryRow(ctx, `
		SELECT id, tenant_id, mode, generation, status, activated_at, retired_at, purge_after, purged_at
		FROM data_spaces WHERE `+predicate, values...,
	).Scan(
		&space.ID, &space.TenantID, &space.Mode, &space.Generation, &space.Status,
		&space.ActivatedAt, &space.RetiredAt, &space.PurgeAfter, &space.PurgedAt,
	)
	return space, err
}

func (s *Store) SwitchSession(
	ctx context.Context,
	current domain.Principal,
	currentTokenHash, replacementTokenHash []byte,
	dataSpaceID uuid.UUID,
) (domain.Principal, error) {
	defer observability.StartSegment(ctx, "Postgres.SwitchSession")()
	// READ COMMITTED is required for the same reason as Sandbox activation and
	// sync mutation application: a SERIALIZABLE transaction can keep the
	// pre-reset snapshot it acquired while waiting for this advisory lock.
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return domain.Principal{}, dbError(err, "begin mode switch")
	}
	defer tx.Rollback(ctx)
	if _, err = lockTenantAccess(ctx, tx, current); err != nil {
		return domain.Principal{}, err
	}
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))`, sandboxGenerationLock+":"+current.TenantID.String()); err != nil {
		return domain.Principal{}, dbError(err, "lock mode switch")
	}
	var targetMode domain.DataMode
	var targetStatus domain.DataSpaceStatus
	if err = tx.QueryRow(ctx, `
		SELECT mode, status FROM data_spaces WHERE id = $1 AND tenant_id = $2 FOR SHARE`,
		dataSpaceID, current.TenantID,
	).Scan(&targetMode, &targetStatus); err != nil {
		return domain.Principal{}, dbError(err, "validate mode-switch data space")
	}
	if targetStatus != domain.DataSpaceStatusActive {
		if targetMode == domain.DataModeSandbox {
			return domain.Principal{}, domain.NewError(
				domain.CodeSandboxGenerationRetired,
				"Generasi Sandbox telah diganti. Muat ulang data Sandbox untuk melanjutkan",
			)
		}
		return domain.Principal{}, domain.NewError(
			domain.CodeForbidden,
			"Ruang data produksi tidak aktif",
		)
	}
	var revokedAt *time.Time
	var revokedReason *string
	var currentMode domain.DataMode
	var currentStatus domain.DataSpaceStatus
	if err = tx.QueryRow(ctx, `
		SELECT s.revoked_at, s.revoked_reason, ds.mode, ds.status
		FROM sessions s
		JOIN data_spaces ds ON ds.id = s.data_space_id
		WHERE s.id = $1 AND s.user_id = $2 AND s.data_space_id = $3
		  AND s.token_hash = $4
		FOR UPDATE OF s`,
		current.SessionID,
		current.UserID,
		current.EffectiveDataSpaceID(),
		currentTokenHash,
	).Scan(&revokedAt, &revokedReason, &currentMode, &currentStatus); err != nil {
		return domain.Principal{}, dbError(err, "validate current mode session")
	}
	if currentMode == domain.DataModeSandbox &&
		(currentStatus != domain.DataSpaceStatusActive ||
			(revokedReason != nil && *revokedReason == "sandbox_generation_retired")) {
		return domain.Principal{}, domain.NewError(
			domain.CodeSandboxGenerationRetired,
			"Generasi Sandbox telah diganti. Muat ulang data Sandbox untuk melanjutkan",
		)
	}
	if revokedAt != nil || currentStatus != domain.DataSpaceStatusActive {
		return domain.Principal{}, domain.NewError(domain.CodeUnauthorized, "Sesi tidak valid atau telah dicabut")
	}

	var sessionID uuid.UUID
	if err = tx.QueryRow(ctx, `
		INSERT INTO sessions (user_id, terminal_id, token_hash, data_space_id,tenant_id,membership_id,context_kind,legacy_origin,protocol_version,sandbox_qris_policy)
		SELECT user_id,terminal_id,$2,$3,tenant_id,membership_id,'tenant',false,protocol_version,sandbox_qris_policy FROM sessions WHERE id=$1
		RETURNING id`, current.SessionID, replacementTokenHash, dataSpaceID,
	).Scan(&sessionID); err != nil {
		return domain.Principal{}, dbError(err, "create switched session")
	}
	revoked, err := tx.Exec(ctx, `
		UPDATE sessions
		SET revoked_at = now(), revoked_reason = 'mode_switched'
		WHERE id = $1 AND revoked_at IS NULL`, current.SessionID,
	)
	if err != nil {
		return domain.Principal{}, dbError(err, "revoke previous mode session")
	}
	if revoked.RowsAffected() != 1 {
		return domain.Principal{}, domain.NewError(
			domain.CodeUnauthorized,
			"Sesi tidak valid atau telah dicabut",
		)
	}
	principal, err := principalBySessionRow(ctx, tx, sessionID, replacementTokenHash)
	if err != nil {
		return domain.Principal{}, dbError(err, "read switched session")
	}
	if err = tx.Commit(ctx); err != nil {
		return domain.Principal{}, dbError(err, "commit mode switch")
	}
	return principal, nil
}

// RecoverRetiredSandboxSession consumes exactly one session revoked by a
// Sandbox reset and replaces it with a session in the currently active target
// space. It is deliberately separate from SwitchSession: no other revocation
// reason may be used to regain access.
func (s *Store) RecoverRetiredSandboxSession(
	ctx context.Context,
	current domain.Principal,
	currentTokenHash, replacementTokenHash []byte,
	dataSpaceID uuid.UUID,
) (domain.Principal, error) {
	defer observability.StartSegment(ctx, "Postgres.RecoverRetiredSandboxSession")()
	unauthorized := func() error {
		return domain.NewError(domain.CodeUnauthorized, "Sesi tidak valid atau telah dicabut")
	}
	if current.SessionID == uuid.Nil || current.UserID == uuid.Nil ||
		current.EffectiveDataMode() != domain.DataModeSandbox {
		return domain.Principal{}, unauthorized()
	}

	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return domain.Principal{}, dbError(err, "begin retired Sandbox recovery")
	}
	defer tx.Rollback(ctx)

	// Reset and purge take the exclusive form. Taking this first prevents the
	// target generation from changing between validation and session creation.
	var recoveryAccountActive bool
	if err = tx.QueryRow(ctx, `SELECT is_active AND deleted_at IS NULL AND NOT must_change_password FROM users WHERE id = $1 FOR SHARE`, current.UserID).Scan(&recoveryAccountActive); err != nil || !recoveryAccountActive {
		return domain.Principal{}, unauthorized()
	}
	var recoveryTenantStatus string
	if err = tx.QueryRow(ctx, `SELECT status FROM tenants WHERE id = $1 FOR SHARE`, current.TenantID).Scan(&recoveryTenantStatus); err != nil || recoveryTenantStatus != "active" {
		return domain.Principal{}, unauthorized()
	}
	var recoveryMembershipID uuid.UUID
	if err = tx.QueryRow(ctx, `SELECT id FROM tenant_memberships WHERE id = $1 AND user_id = $2 AND tenant_id = $3 FOR SHARE`, current.MembershipID, current.UserID, current.TenantID).Scan(&recoveryMembershipID); err != nil {
		return domain.Principal{}, unauthorized()
	}
	if _, err = tx.Exec(ctx,
		`SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))`,
		sandboxGenerationLock+":"+current.TenantID.String(),
	); err != nil {
		return domain.Principal{}, dbError(err, "lock retired Sandbox recovery")
	}

	if current.TenantID == uuid.Nil || dataSpaceID == uuid.Nil {
		return domain.Principal{}, unauthorized()
	}
	var targetMode domain.DataMode
	var targetStatus domain.DataSpaceStatus
	if err = tx.QueryRow(ctx, `
		SELECT mode, status FROM data_spaces WHERE id = $1 AND tenant_id = $2 FOR SHARE`,
		dataSpaceID, current.TenantID,
	).Scan(&targetMode, &targetStatus); err != nil {
		return domain.Principal{}, dbError(err, "validate recovery data space")
	}
	if targetStatus != domain.DataSpaceStatusActive {
		if targetMode == domain.DataModeSandbox {
			return domain.Principal{}, domain.NewError(
				domain.CodeSandboxGenerationRetired,
				"Generasi Sandbox telah diganti. Muat ulang data Sandbox untuk melanjutkan",
			)
		}
		return domain.Principal{}, domain.NewError(domain.CodeForbidden, "Ruang data produksi tidak aktif")
	}

	var revokedAt time.Time
	var oldTerminalID *uuid.UUID
	var oldMode domain.DataMode
	var oldStatus domain.DataSpaceStatus
	if err = tx.QueryRow(ctx, `
		SELECT s.revoked_at, s.terminal_id, ds.mode, ds.status
		FROM sessions s
		JOIN data_spaces ds ON ds.id = s.data_space_id
		WHERE s.id = $1 AND s.user_id = $2 AND s.data_space_id = $3
		  AND s.token_hash = $4
		  AND s.revoked_at IS NOT NULL
		  AND s.revoked_reason = 'sandbox_generation_retired'
		  AND s.revoked_at = ds.retired_at
		FOR UPDATE OF s`,
		current.SessionID,
		current.UserID,
		current.EffectiveDataSpaceID(),
		currentTokenHash,
	).Scan(&revokedAt, &oldTerminalID, &oldMode, &oldStatus); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.Principal{}, unauthorized()
		}
		return domain.Principal{}, dbError(err, "lock retired Sandbox session")
	}
	if oldMode != domain.DataModeSandbox || oldStatus != domain.DataSpaceStatusRetired {
		return domain.Principal{}, unauthorized()
	}

	// Lock shared identity state before creating the replacement. The timestamp
	// checks prevent a reset-revoked token from resurrecting access after a
	// later password, role, profile, or terminal security change. Holding these
	// row locks also closes the race with a change that starts concurrently.
	var userActive, mustChangePassword bool
	var userDeletedAt *time.Time
	var userUpdatedAt time.Time
	if err = tx.QueryRow(ctx, `
		SELECT is_active, must_change_password, deleted_at, updated_at
		FROM users WHERE id = $1 FOR SHARE`,
		current.UserID,
	).Scan(&userActive, &mustChangePassword, &userDeletedAt, &userUpdatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.Principal{}, unauthorized()
		}
		return domain.Principal{}, dbError(err, "lock recovery user")
	}
	if !userActive || mustChangePassword || userDeletedAt != nil || userUpdatedAt.After(revokedAt) {
		return domain.Principal{}, unauthorized()
	}

	if oldTerminalID != nil {
		var terminalActive bool
		var terminalRevokedAt *time.Time
		var terminalUpdatedAt time.Time
		if err = tx.QueryRow(ctx, `
			SELECT is_active, revoked_at, updated_at
			FROM terminals WHERE id = $1 AND tenant_id = $2 FOR SHARE`,
			*oldTerminalID, current.TenantID,
		).Scan(&terminalActive, &terminalRevokedAt, &terminalUpdatedAt); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return domain.Principal{}, unauthorized()
			}
			return domain.Principal{}, dbError(err, "lock recovery terminal")
		}
		if !terminalActive || terminalRevokedAt != nil || terminalUpdatedAt.After(revokedAt) {
			return domain.Principal{}, unauthorized()
		}
	}

	consumed, err := tx.Exec(ctx, `
		UPDATE sessions
		SET revoked_reason = 'sandbox_generation_recovered'
		WHERE id = $1 AND token_hash = $2
		  AND revoked_at = $3
		  AND revoked_reason = 'sandbox_generation_retired'`,
		current.SessionID, currentTokenHash, revokedAt,
	)
	if err != nil {
		return domain.Principal{}, dbError(err, "consume retired Sandbox session")
	}
	if consumed.RowsAffected() != 1 {
		return domain.Principal{}, unauthorized()
	}

	var replacementSessionID uuid.UUID
	if err = tx.QueryRow(ctx, `
		INSERT INTO sessions (user_id, terminal_id, token_hash, data_space_id,tenant_id,membership_id,context_kind,legacy_origin,protocol_version,sandbox_qris_policy)
		SELECT user_id,terminal_id,$2,$3,tenant_id,membership_id,'tenant',false,protocol_version,sandbox_qris_policy FROM sessions WHERE id=$1
		RETURNING id`,
		current.SessionID, replacementTokenHash, dataSpaceID,
	).Scan(&replacementSessionID); err != nil {
		return domain.Principal{}, dbError(err, "create recovered session")
	}
	principal, err := principalBySessionRow(ctx, tx, replacementSessionID, replacementTokenHash)
	if err != nil {
		return domain.Principal{}, dbError(err, "read recovered session")
	}
	if err = tx.Commit(ctx); err != nil {
		return domain.Principal{}, dbError(err, "commit retired Sandbox recovery")
	}
	return principal, nil
}

func lockActiveDataSpace(ctx context.Context, tx pgx.Tx, id uuid.UUID) (domain.DataSpace, error) {
	defer observability.StartSegment(ctx, "Postgres.lockActiveDataSpace")()
	if id == uuid.Nil {
		return domain.DataSpace{}, domain.NewError(domain.CodeForbidden, "Pilih ruang data usaha untuk melanjutkan")
	}
	var mode domain.DataMode
	var tenantID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT mode, tenant_id FROM data_spaces WHERE id = $1`, id).Scan(&mode, &tenantID); err != nil {
		return domain.DataSpace{}, dbError(err, "find mutation data space")
	}
	if mode == domain.DataModeSandbox {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))`, sandboxGenerationLock+":"+tenantID.String()); err != nil {
			return domain.DataSpace{}, dbError(err, "lock sandbox generation")
		}
	}
	space, err := dataSpaceByQuery(ctx, tx, `id = $1`, id)
	if err != nil {
		return domain.DataSpace{}, dbError(err, "read mutation data space")
	}
	if space.Status != domain.DataSpaceStatusActive {
		if space.Mode == domain.DataModeSandbox {
			return domain.DataSpace{}, domain.NewError(
				domain.CodeSandboxGenerationRetired,
				"Generasi Sandbox telah diganti. Muat ulang data Sandbox untuk melanjutkan",
			)
		}
		return domain.DataSpace{}, domain.NewError(domain.CodeForbidden, "Ruang data produksi tidak aktif")
	}
	return space, nil
}

// EnsureSandbox atomically creates and seeds the first shared Sandbox
// generation. It is intentionally invoked only when SANDBOX_ENABLED is true,
// after the additive schema rollout and compatible mobile release.
func (s *Store) EnsureSandbox(ctx context.Context, tenantID uuid.UUID) (domain.DataSpace, error) {
	defer observability.StartSegment(ctx, "Postgres.EnsureSandbox")()
	// READ COMMITTED is deliberate here. PostgreSQL establishes a SERIALIZABLE
	// snapshot before evaluating the advisory-lock statement, so a replica that
	// waits for another replica could retain a pre-activation snapshot and try to
	// create the generation again. The exclusive transaction lock provides the
	// serialization we need, while READ COMMITTED makes the lookup after the lock
	// observe the winner's committed generation.
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return domain.DataSpace{}, dbError(err, "begin sandbox activation")
	}
	defer tx.Rollback(ctx)
	if tenantID == uuid.Nil {
		return domain.DataSpace{}, domain.NewError(domain.CodeForbidden, "Pilih usaha untuk melanjutkan")
	}
	var tenantStatus string
	if err = tx.QueryRow(ctx, `SELECT status FROM tenants WHERE id = $1 FOR SHARE`, tenantID).Scan(&tenantStatus); err != nil {
		return domain.DataSpace{}, dbError(err, "lock Sandbox tenant")
	}
	if tenantStatus != "active" {
		return domain.DataSpace{}, domain.NewError(domain.CodeTenantSuspended, "Usaha sedang dinonaktifkan")
	}
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, sandboxGenerationLock+":"+tenantID.String()); err != nil {
		return domain.DataSpace{}, dbError(err, "lock sandbox activation")
	}

	space, err := s.ensureSandboxTx(ctx, tx, tenantID, nil)
	if err != nil {
		return domain.DataSpace{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return domain.DataSpace{}, dbError(err, "commit sandbox activation")
	}
	return space, nil
}

func (s *Store) ensureSandboxTx(
	ctx context.Context,
	tx pgx.Tx,
	tenantID uuid.UUID,
	actor *domain.Principal,
) (domain.DataSpace, error) {
	space, err := dataSpaceByQuery(
		ctx,
		tx,
		`tenant_id = $1 AND mode = $2 AND status = 'active' FOR UPDATE`,
		tenantID, domain.DataModeSandbox,
	)
	if err == nil {
		return space, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return domain.DataSpace{}, dbError(err, "find active sandbox during activation")
	}

	var generation int64
	if err = tx.QueryRow(ctx, `
		SELECT COALESCE(max(generation), 0) + 1
		FROM data_spaces
		WHERE mode = 'sandbox' AND tenant_id = $1`, tenantID,
	).Scan(&generation); err != nil {
		return domain.DataSpace{}, dbError(err, "choose initial sandbox generation")
	}
	now := s.Now()
	space = domain.DataSpace{
		ID: uuid.New(), TenantID: tenantID, Mode: domain.DataModeSandbox, Generation: generation,
		Status: domain.DataSpaceStatusActive, ActivatedAt: now,
	}
	if _, err = tx.Exec(ctx, `
		INSERT INTO data_spaces (id, mode, generation, status, activated_at, tenant_id)
		VALUES ($1, 'sandbox', $2, 'active', $3, $4)`,
		space.ID, space.Generation, space.ActivatedAt, tenantID,
	); err != nil {
		return domain.DataSpace{}, dbError(err, "create initial sandbox generation")
	}
	var actorID *uuid.UUID
	if actor != nil {
		actorID = &actor.UserID
	}
	cloned, err := cloneProductionPackages(ctx, tx, space.ID, actorID, now, "Klon awal Sandbox")
	if err != nil {
		return domain.DataSpace{}, dbError(err, "clone initial sandbox packages")
	}
	if err = seedSharedSyncChanges(ctx, tx, space.ID); err != nil {
		return domain.DataSpace{}, dbError(err, "seed initial sandbox shared changes")
	}
	production, err := dataSpaceByQuery(ctx, tx, `tenant_id = $1 AND mode = 'production' AND status = 'active'`, tenantID)
	if err != nil {
		return domain.DataSpace{}, dbError(err, "find Sandbox audit space")
	}
	activationIdentity := domain.MutationIdentity{DataSpaceID: production.ID, TenantID: tenantID}
	if actor != nil {
		activationIdentity = principalIdentity(*actor)
	}
	if err = audit(
		ctx,
		tx,
		"sandbox.activated",
		"data_space",
		space.ID.String(),
		activationIdentity,
		nil,
		space,
		map[string]any{"clonedPackageCount": cloned},
		now,
	); err != nil {
		return domain.DataSpace{}, dbError(err, "audit sandbox activation")
	}
	return space, nil
}

func (s *Store) ConfigureSandbox(
	ctx context.Context,
	actor domain.Principal,
	enabled bool,
) error {
	defer observability.StartSegment(ctx, "Postgres.ConfigureSandbox")()
	if !actor.IsSuperadmin() || actor.EffectiveDataMode() != domain.DataModeProduction {
		return domain.NewError(domain.CodeForbidden, "Pengaturan Mode Uji hanya tersedia untuk Superadmin di Mode Produksi")
	}
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return dbError(err, "begin sandbox configuration")
	}
	defer tx.Rollback(ctx)
	role, err := lockTenantLifecycleAccess(ctx, tx, actor)
	if err != nil {
		return err
	}
	if role != domain.RoleSuperadmin {
		return domain.NewError(domain.CodeForbidden, "Pengaturan Mode Uji hanya tersedia untuk Superadmin")
	}
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, sandboxGenerationLock+":"+actor.TenantID.String()); err != nil {
		return dbError(err, "lock sandbox configuration")
	}
	if enabled {
		if _, err = s.ensureSandboxTx(ctx, tx, actor.TenantID, &actor); err != nil {
			return err
		}
	}
	var before *bool
	if err = tx.QueryRow(ctx, `SELECT sandbox_enabled_override FROM tenants WHERE id=$1`, actor.TenantID).Scan(&before); err != nil {
		return dbError(err, "read sandbox configuration")
	}
	if before == nil || *before != enabled {
		if _, err = tx.Exec(ctx, `UPDATE tenants SET sandbox_enabled_override=$2,updated_at=now() WHERE id=$1`, actor.TenantID, enabled); err != nil {
			return dbError(err, "update sandbox configuration")
		}
		if err = controlAudit(ctx, tx, &actor.UserID, &actor.TenantID, "tenant.sandbox_enabled_changed", map[string]any{
			"before":  before,
			"enabled": enabled,
		}); err != nil {
			return dbError(err, "audit sandbox configuration")
		}
	}
	return dbError(tx.Commit(ctx), "commit sandbox configuration")
}

func (s *Store) ResetSandbox(
	ctx context.Context,
	actor domain.Principal,
	expectedGeneration int64,
	retention time.Duration,
) (domain.SandboxResetResult, error) {
	defer observability.StartSegment(ctx, "Postgres.ResetSandbox")()
	if !actor.IsSuperadmin() || actor.EffectiveDataMode() != domain.DataModeProduction {
		return domain.SandboxResetResult{}, domain.NewError(domain.CodeForbidden, "Reset Sandbox hanya tersedia untuk superadmin di mode produksi")
	}
	// The generation lock is the serialization boundary. READ COMMITTED makes
	// the active-generation lookup after a wait observe the reset that won the
	// lock instead of retaining a pre-wait SERIALIZABLE snapshot.
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return domain.SandboxResetResult{}, dbError(err, "begin sandbox reset")
	}
	defer tx.Rollback(ctx)
	role, err := lockTenantLifecycleAccess(ctx, tx, actor)
	if err != nil {
		return domain.SandboxResetResult{}, err
	}
	if role != domain.RoleSuperadmin {
		return domain.SandboxResetResult{}, domain.NewError(domain.CodeForbidden, "Reset Sandbox hanya tersedia untuk superadmin")
	}
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, sandboxGenerationLock+":"+actor.TenantID.String()); err != nil {
		return domain.SandboxResetResult{}, dbError(err, "lock sandbox reset")
	}

	previous, err := dataSpaceByQuery(ctx, tx, `tenant_id = $1 AND mode = $2 AND status = 'active' FOR UPDATE`, actor.TenantID, domain.DataModeSandbox)
	if err != nil {
		return domain.SandboxResetResult{}, dbError(err, "lock active sandbox")
	}
	if expectedGeneration != previous.Generation {
		return domain.SandboxResetResult{}, &domain.Error{
			Code: domain.CodeConflict, Message: "Generasi Sandbox telah berubah",
			Details: map[string]any{"expectedGeneration": expectedGeneration, "currentGeneration": previous.Generation},
		}
	}
	if retention < 24*time.Hour {
		retention = 30 * 24 * time.Hour
	}
	now := s.Now()
	purgeAfter := now.Add(retention)
	if _, err = tx.Exec(ctx, `
		UPDATE data_spaces
		SET status = 'retired', retired_at = $2, purge_after = $3
		WHERE id = $1 AND status = 'active'`, previous.ID, now, purgeAfter,
	); err != nil {
		return domain.SandboxResetResult{}, dbError(err, "retire sandbox generation")
	}
	previous.Status = domain.DataSpaceStatusRetired
	previous.RetiredAt = &now
	previous.PurgeAfter = &purgeAfter

	current := domain.DataSpace{
		ID: uuid.New(), TenantID: actor.TenantID, Mode: domain.DataModeSandbox,
		Generation: previous.Generation + 1, Status: domain.DataSpaceStatusActive,
		ActivatedAt: now,
	}
	if _, err = tx.Exec(ctx, `
		INSERT INTO data_spaces (id, mode, generation, status, activated_at, tenant_id)
		VALUES ($1,'sandbox',$2,'active',$3,$4)`, current.ID, current.Generation, now, actor.TenantID,
	); err != nil {
		return domain.SandboxResetResult{}, dbError(err, "activate sandbox generation")
	}

	cloned, err := cloneProductionPackages(
		ctx,
		tx,
		current.ID,
		&actor.UserID,
		now,
		"Klon reset Sandbox",
	)
	if err != nil {
		return domain.SandboxResetResult{}, dbError(err, "clone reset sandbox packages")
	}
	if err = seedSharedSyncChanges(ctx, tx, current.ID); err != nil {
		return domain.SandboxResetResult{}, dbError(err, "seed reset shared sync changes")
	}
	revoked, err := tx.Exec(ctx, `
		UPDATE sessions
		SET revoked_at = $2, revoked_reason = 'sandbox_generation_retired'
		WHERE data_space_id = $1 AND revoked_at IS NULL`, previous.ID, now,
	)
	if err != nil {
		return domain.SandboxResetResult{}, dbError(err, "revoke retired sandbox sessions")
	}
	result := domain.SandboxResetResult{
		Previous: previous, Current: current, ClonedPackageCount: cloned,
		RevokedSessionCount: revoked.RowsAffected(),
	}
	identity := principalIdentity(actor)
	if err = audit(ctx, tx, "sandbox.reset", "data_space", current.ID.String(), identity,
		previous, current, map[string]any{
			"clonedPackageCount": cloned, "retentionDays": int(retention.Hours() / 24),
		}, now); err != nil {
		return domain.SandboxResetResult{}, dbError(err, "audit sandbox reset")
	}
	if err = tx.Commit(ctx); err != nil {
		return domain.SandboxResetResult{}, dbError(err, "commit sandbox reset")
	}
	return result, nil
}

func cloneProductionPackages(
	ctx context.Context,
	tx pgx.Tx,
	targetDataSpaceID uuid.UUID,
	actorID *uuid.UUID,
	now time.Time,
	changeReason string,
) (int, error) {
	defer observability.StartSegment(ctx, "Postgres.cloneProductionPackages")()
	if _, err := tx.Exec(ctx, `
		CREATE TEMP TABLE sandbox_package_clone ON COMMIT DROP AS
		SELECT gen_random_uuid() AS new_id,
		       p.id AS source_id,
		       p.current_revision AS source_revision,
		       p.code,
		       r.name,
		       r.description,
		       r.unit_price,
		       p.created_by AS source_created_by,
		       p.updated_by AS source_updated_by
		FROM packages p
		JOIN package_revisions r
		  ON r.package_id = p.id AND r.revision = p.current_revision
		 AND r.data_space_id = p.data_space_id
		JOIN data_spaces source_space ON source_space.id = p.data_space_id
		JOIN data_spaces target_space ON target_space.id = $1 AND target_space.tenant_id = source_space.tenant_id
		WHERE source_space.mode = 'production' AND source_space.status = 'active' AND p.deleted_at IS NULL`,
		targetDataSpaceID,
	); err != nil {
		return 0, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO packages (
			id, data_space_id, code, current_revision, created_by, updated_by,
			source_package_id, source_revision, created_at, updated_at
		)
		SELECT new_id, $1, code, 1,
		       COALESCE($2::uuid, source_created_by),
		       COALESCE($2::uuid, source_updated_by),
		       source_id, source_revision, $3, $3
		FROM sandbox_package_clone`,
		targetDataSpaceID, actorID, now,
	); err != nil {
		return 0, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO package_revisions (
			package_id, revision, data_space_id, name, description, unit_price,
			change_reason, created_by, created_at
		)
		SELECT new_id, 1, $1, name, description, unit_price, $2,
		       COALESCE($3::uuid, source_updated_by, source_created_by), $4
		FROM sandbox_package_clone`,
		targetDataSpaceID, changeReason, actorID, now,
	); err != nil {
		return 0, err
	}
	var cloned int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM sandbox_package_clone`).Scan(&cloned); err != nil {
		return 0, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO sync_changes (
			data_space_id, aggregate, aggregate_id, action, revision, payload, tombstone
		)
		SELECT p.data_space_id, 'package', p.id::text, 'created', 1,
		       jsonb_build_object(
				'id', p.id, 'code', p.code, 'revision', 1,
				'name', r.name, 'description', r.description, 'unitPrice', r.unit_price,
				'createdAt', p.created_at, 'updatedAt', p.updated_at,
				'dataSpaceId', p.data_space_id,
				'sourcePackageId', p.source_package_id, 'sourceRevision', p.source_revision
		       ), false
		FROM packages p
		JOIN package_revisions r
		  ON r.package_id = p.id AND r.revision = 1
		 AND r.data_space_id = p.data_space_id
		WHERE p.data_space_id = $1`,
		targetDataSpaceID,
	); err != nil {
		return 0, err
	}
	return cloned, nil
}

func (s *Store) CleanupExpiredSandboxes(ctx context.Context, now time.Time) (domain.SandboxCleanupResult, error) {
	defer observability.StartSegment(ctx, "Postgres.CleanupExpiredSandboxes")()
	// Cleanup calls are serialized by the generation lock. READ COMMITTED makes
	// a waiter re-read the generations purged by the preceding lock holder.
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return domain.SandboxCleanupResult{}, dbError(err, "begin sandbox cleanup")
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, sandboxGenerationLock); err != nil {
		return domain.SandboxCleanupResult{}, dbError(err, "lock sandbox cleanup")
	}
	rows, err := tx.Query(ctx, `
		SELECT id, tenant_id, generation FROM data_spaces
		WHERE mode = 'sandbox' AND status = 'retired' AND purge_after <= $1
		ORDER BY tenant_id, generation`, now,
	)
	if err != nil {
		return domain.SandboxCleanupResult{}, dbError(err, "list expired sandbox generations")
	}
	type expiredSpace struct {
		id         uuid.UUID
		tenantID   uuid.UUID
		generation int64
	}
	spaces := make([]expiredSpace, 0)
	for rows.Next() {
		var space expiredSpace
		if err = rows.Scan(&space.id, &space.tenantID, &space.generation); err != nil {
			rows.Close()
			return domain.SandboxCleanupResult{}, dbError(err, "scan expired sandbox generation")
		}
		spaces = append(spaces, space)
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		return domain.SandboxCleanupResult{}, dbError(err, "iterate expired sandbox generations")
	}
	rows.Close()

	result := domain.SandboxCleanupResult{}
	deleteTables := []string{
		"print_attempts", "transaction_items", "transaction_revisions", "transactions",
		"package_revisions", "packages", "idempotency_records", "sync_changes",
		"audit_events", "sessions",
	}
	for _, space := range spaces {
		if _, err = tx.Exec(ctx, `SELECT id FROM tenants WHERE id = $1 FOR SHARE`, space.tenantID); err != nil {
			return domain.SandboxCleanupResult{}, dbError(err, "lock purge tenant")
		}
		if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, sandboxGenerationLock+":"+space.tenantID.String()); err != nil {
			return domain.SandboxCleanupResult{}, dbError(err, "lock tenant sandbox cleanup")
		}
		var stillExpired bool
		if err = tx.QueryRow(ctx, `SELECT status = 'retired' AND mode = 'sandbox' AND purge_after <= $2 FROM data_spaces WHERE id = $1 FOR UPDATE`, space.id, now).Scan(&stillExpired); err != nil {
			return domain.SandboxCleanupResult{}, dbError(err, "recheck expired Sandbox")
		}
		if !stillExpired {
			continue
		}
		production, queryErr := dataSpaceByQuery(ctx, tx, `tenant_id = $1 AND mode = 'production' AND status = 'active'`, space.tenantID)
		if queryErr != nil {
			return domain.SandboxCleanupResult{}, dbError(queryErr, "find purge audit space")
		}
		generationRows := int64(0)
		if _, err = tx.Exec(ctx, `SELECT set_config('app.sandbox_purge_data_space_id', $1, true)`, space.id.String()); err != nil {
			return domain.SandboxCleanupResult{}, dbError(err, "authorize sandbox purge")
		}
		for _, table := range deleteTables {
			tag, deleteErr := tx.Exec(ctx, fmt.Sprintf(`DELETE FROM %s WHERE data_space_id = $1`, table), space.id)
			if deleteErr != nil {
				return domain.SandboxCleanupResult{}, dbError(deleteErr, "purge sandbox "+table)
			}
			generationRows += tag.RowsAffected()
			result.PurgedRowCount += tag.RowsAffected()
		}
		if _, err = tx.Exec(ctx, `
			UPDATE data_spaces SET status = 'purged', purged_at = $2
			WHERE id = $1 AND status = 'retired'`, space.id, now,
		); err != nil {
			return domain.SandboxCleanupResult{}, dbError(err, "mark sandbox generation purged")
		}
		metadata, _ := json.Marshal(map[string]any{
			"generation": space.generation, "purgedRows": generationRows,
		})
		if _, err = tx.Exec(ctx, `
			INSERT INTO audit_events (
				data_space_id, event_type, aggregate_type, aggregate_id,
				metadata, occurred_at
			) VALUES ($1,'sandbox.purged','data_space',$2,$3,$4)`,
			production.ID, space.id.String(), metadata, now,
		); err != nil {
			return domain.SandboxCleanupResult{}, dbError(err, "audit sandbox purge")
		}
		result.PurgedGenerationCount++
	}
	if err = tx.Commit(ctx); err != nil {
		return domain.SandboxCleanupResult{}, dbError(err, "commit sandbox cleanup")
	}
	return result, nil
}

func seedSharedSyncChanges(ctx context.Context, tx pgx.Tx, dataSpaceID uuid.UUID) error {
	defer observability.StartSegment(ctx, "Postgres.seedSharedSyncChanges")()
	if _, err := tx.Exec(ctx, `INSERT INTO sync_changes(data_space_id,aggregate,aggregate_id,action,revision,payload,tombstone)
	 SELECT ds.id,'tenant_metadata',t.id::text,'created',t.management_revision,
	 jsonb_build_object('id',t.id,'name',t.name,'slug',t.slug,'status',t.status,'revision',t.management_revision,'profileRevision',t.profile_revision,'qrisRevision',t.qris_revision),false
	 FROM data_spaces ds JOIN tenants t ON t.id=ds.tenant_id WHERE ds.id=$1`, dataSpaceID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO sync_changes (
			data_space_id, aggregate, aggregate_id, action, payload, tombstone
		)
		SELECT $1, 'user', u.id::text, 'created',
		       jsonb_build_object(
			'id', u.id, 'fullName', u.full_name, 'username', u.username,
			'role', u.role, 'active', u.is_active,
			'membershipId', m.id, 'tenantId', ds.tenant_id,
			'mustChangePassword', u.must_change_password,
			'createdAt', u.created_at, 'updatedAt', u.updated_at,
			'deletedAt', u.deleted_at
		       ), false
		FROM users u
		JOIN data_spaces ds ON ds.id = $1
		LEFT JOIN tenant_memberships m ON m.user_id = u.id AND m.tenant_id = ds.tenant_id
		WHERE u.is_active AND u.deleted_at IS NULL
		ORDER BY u.id`, dataSpaceID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO sync_changes (
			data_space_id, aggregate, aggregate_id, action, payload, tombstone
		)
		SELECT $1, 'terminal', t.id::text, 'created',
		       jsonb_build_object(
			'id', t.id, 'installationId', t.installation_id,
			'name', t.name, 'publicKey', encode(t.public_key, 'base64'),
			'algorithm', 'Ed25519', 'platform', t.platform,
			'deviceModel', t.device_model, 'osVersion', t.os_version,
			'appVersion', t.app_version, 'active', t.is_active,
			'enrolledAt', t.created_at, 'revokedAt', t.revoked_at
		       ), false
		FROM terminals t
		JOIN data_spaces ds ON ds.tenant_id = t.tenant_id AND ds.id = $1
		WHERE t.is_active AND t.revoked_at IS NULL
		ORDER BY t.id`, dataSpaceID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO sync_changes (data_space_id,aggregate,aggregate_id,action,revision,payload,tombstone)
		SELECT ds.id,'tenant_profile',ds.tenant_id::text,'created',p.revision,
		       jsonb_build_object('tenantId',ds.tenant_id,'revision',p.revision,'businessName',p.business_name,'address',p.address,'phone',p.phone),false
		FROM data_spaces ds JOIN tenants t ON t.id=ds.tenant_id
		JOIN tenant_profile_revisions p ON p.tenant_id=t.id AND p.revision=t.profile_revision
		WHERE ds.id=$1`, dataSpaceID); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO sync_changes (data_space_id,aggregate,aggregate_id,action,revision,payload,tombstone)
		SELECT ds.id,'tenant_qris',ds.tenant_id::text,'created',COALESCE(max(q.revision),0),
		       jsonb_build_object('revision',COALESCE(max(q.revision),0),'activePayloadHash',max(q.payload_hash) FILTER (WHERE q.revision=t.qris_revision),
		         'payloads',COALESCE(jsonb_agg(jsonb_build_object('tenantId',q.tenant_id,'revision',q.revision,'payloadHash',q.payload_hash,'staticPayload',q.static_payload) ORDER BY q.revision) FILTER (WHERE q.revision IS NOT NULL),'[]'::jsonb)),false
		FROM data_spaces ds JOIN tenants t ON t.id=ds.tenant_id
		LEFT JOIN tenant_qris_revisions q ON q.tenant_id=t.id
		WHERE ds.id=$1 GROUP BY ds.id,ds.tenant_id,t.qris_revision`, dataSpaceID)
	if err != nil {
		return err
	}
	return nil
}
