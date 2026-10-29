package postgres

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/domain"
	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/observability"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/newrelic/go-agent/v3/integrations/nrpgx5"
	"github.com/sirupsen/logrus"
	gormpostgres "gorm.io/driver/postgres"
	"gorm.io/gorm"
)

type Store struct {
	Pool   *pgxpool.Pool
	ORM    *gorm.DB
	ormSQL *sql.DB
	Logger *logrus.Logger
	Now    func() time.Time
}

type Option func(*storeOptions)

type storeOptions struct {
	logger *logrus.Logger
}

func WithLogger(logger *logrus.Logger) Option {
	return func(options *storeOptions) {
		options.logger = logger
	}
}

func Open(ctx context.Context, databaseURL string, options ...Option) (*Store, error) {
	defer observability.StartSegment(ctx, "Postgres.Open")()

	settings := storeOptions{logger: observability.Logger()}
	for _, option := range options {
		option(&settings)
	}
	if settings.logger == nil {
		settings.logger = observability.Logger()
	}

	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse DATABASE_URL: %w", err)
	}
	configureConnectionTracing(config)
	config.MaxConns = 10
	config.MinConns = 2
	config.MaxConnLifetime = time.Hour
	config.MaxConnIdleTime = 15 * time.Minute
	config.HealthCheckPeriod = 30 * time.Second
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, fmt.Errorf("open postgres pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping postgres: %w", err)
	}

	orm, err := gorm.Open(gormpostgres.Open(databaseURL), &gorm.Config{
		Logger:         newGORMLogger(settings.logger),
		TranslateError: true,
	})
	if err != nil {
		pool.Close()
		return nil, fmt.Errorf("open GORM postgres connection: %w", err)
	}
	if err := orm.Use(newRelicGORMPlugin{}); err != nil {
		pool.Close()
		return nil, fmt.Errorf("register GORM New Relic plugin: %w", err)
	}
	ormSQL, err := orm.DB()
	if err != nil {
		pool.Close()
		return nil, fmt.Errorf("resolve GORM SQL pool: %w", err)
	}
	ormSQL.SetMaxOpenConns(6)
	ormSQL.SetMaxIdleConns(2)
	ormSQL.SetConnMaxLifetime(time.Hour)
	ormSQL.SetConnMaxIdleTime(15 * time.Minute)
	if err := ormSQL.PingContext(ctx); err != nil {
		_ = ormSQL.Close()
		pool.Close()
		return nil, fmt.Errorf("ping GORM postgres: %w", err)
	}

	return &Store{
		Pool:   pool,
		ORM:    orm,
		ormSQL: ormSQL,
		Logger: settings.logger,
		Now:    func() time.Time { return time.Now().UTC() },
	}, nil
}

func configureConnectionTracing(config *pgxpool.Config) {
	// pgxpool supplies a separate copied configuration to BeforeConnect for each
	// connection. nrpgx5 initializes mutable connection metadata in its tracer,
	// so sharing one tracer across parallel pool connections races that metadata.
	config.BeforeConnect = func(_ context.Context, connection *pgx.ConnConfig) error {
		connection.Tracer = nrpgx5.NewTracer(nrpgx5.WithQueryParameters(false))
		return nil
	}
}

func (s *Store) Close() {
	if s == nil {
		return
	}
	if s.ormSQL != nil {
		if err := s.ormSQL.Close(); err != nil {
			s.Logger.WithError(err).Error("close GORM postgres pool")
		}
	}
	if s.Pool != nil {
		s.Pool.Close()
	}
}

func (s *Store) Ping(ctx context.Context) error {
	defer observability.StartSegment(ctx, "Postgres.Ping")()
	if s.ormSQL != nil {
		if err := s.ormSQL.PingContext(ctx); err != nil {
			observability.NoticeError(ctx, err, "ping GORM postgres")
			return err
		}
	}
	if err := s.Pool.Ping(ctx); err != nil {
		observability.NoticeError(ctx, err, "ping pgx postgres")
		return err
	}
	return nil
}

func dbError(err error, operation string) error {
	if err == nil {
		return nil
	}
	var domainErr *domain.Error
	if errors.As(err, &domainErr) {
		return err
	}
	if errors.Is(err, pgx.ErrNoRows) || errors.Is(err, gorm.ErrRecordNotFound) {
		return domain.NewError(domain.CodeNotFound, "Data tidak ditemukan")
	}
	if errors.Is(err, gorm.ErrDuplicatedKey) {
		return &domain.Error{Code: domain.CodeConflict, Message: "Data sudah digunakan", Cause: err}
	}
	if errors.Is(err, gorm.ErrForeignKeyViolated) {
		return &domain.Error{Code: domain.CodeValidation, Message: "Data tidak memenuhi aturan sistem", Cause: err}
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505":
			return &domain.Error{Code: domain.CodeConflict, Message: "Data sudah digunakan", Details: map[string]any{"constraint": pgErr.ConstraintName}, Cause: err}
		case "23503", "23514", "22P02":
			return &domain.Error{Code: domain.CodeValidation, Message: "Data tidak memenuhi aturan sistem", Details: map[string]any{"constraint": pgErr.ConstraintName}, Cause: err}
		case "40001", "40P01":
			return &domain.Error{Code: domain.CodeConflict, Message: "Data berubah bersamaan; silakan coba lagi", Cause: err}
		}
	}
	return domain.WrapInternal(err, operation)
}

func audit(ctx context.Context, tx pgx.Tx, eventType, aggregateType, aggregateID string, identity domain.MutationIdentity, before, after any, metadata map[string]any, occurredAt time.Time) error {
	defer observability.StartSegment(ctx, "Postgres.audit")()
	beforeJSON, err := nullableJSON(before)
	if err != nil {
		return err
	}
	afterJSON, err := nullableJSON(after)
	if err != nil {
		return err
	}
	metadataJSON, err := json.Marshal(metadata)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO audit_events (
			data_space_id,
			event_type, aggregate_type, aggregate_id,
			origin_actor_id, origin_session_id,
			submitted_by_actor_id, submitted_by_session_id, terminal_id,
			before_values, after_values, metadata, occurred_at
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
		identity.EffectiveDataSpaceID(),
		eventType, aggregateType, aggregateID,
		nilUUID(identity.OriginActorID), nilUUID(identity.OriginSessionID),
		nilUUID(identity.SubmittedByActorID), nilUUID(identity.SubmittedBySessionID), identity.TerminalID,
		beforeJSON, afterJSON, metadataJSON, occurredAt,
	)
	return err
}

func addChange(ctx context.Context, tx pgx.Tx, dataSpaceID uuid.UUID, aggregate, aggregateID, action string, revision *int, payload any, tombstone bool) error {
	defer observability.StartSegment(ctx, "Postgres.addChange")()
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO sync_changes (data_space_id, aggregate, aggregate_id, action, revision, payload, tombstone)
		VALUES ($1,$2,$3,$4,$5,$6,$7)`,
		dataSpaceID, aggregate, aggregateID, action, revision, body, tombstone,
	)
	return err
}

// addSharedChange projects organization accounts into every tenant.
// Terminal events are restricted to the tenant owning that enrollment.
func addSharedChange(ctx context.Context, tx pgx.Tx, aggregate, aggregateID, action string, revision *int, payload any, tombstone bool) error {
	defer observability.StartSegment(ctx, "Postgres.addSharedChange")()
	if aggregate != "user" && aggregate != "terminal" {
		return domain.NewError(domain.CodeForbidden, "Perubahan wajib memiliki ruang usaha")
	}
	rows, err := tx.Query(ctx, `
		SELECT id AS tenant_id FROM tenants WHERE $1 = 'user'
		UNION SELECT tenant_id FROM terminals WHERE $1 = 'terminal' AND id = $2
		ORDER BY tenant_id`, aggregate, aggregateUUID(aggregateID))
	if err != nil {
		return err
	}
	tenantIDs := make([]uuid.UUID, 0)
	for rows.Next() {
		var tenantID uuid.UUID
		if err = rows.Scan(&tenantID); err != nil {
			rows.Close()
			return err
		}
		tenantIDs = append(tenantIDs, tenantID)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, tenantID := range tenantIDs {
		if err = addTenantChange(ctx, tx, tenantID, aggregate, aggregateID, action, revision, payload, tombstone); err != nil {
			return err
		}
	}
	return nil
}

// addTenantChange never copies a caller's user projection into another tenant.
// Roles come from global accounts; membership IDs are historical links. Shared
// generation locks make the fanout atomic with Sandbox activation and reset.
func addTenantChange(ctx context.Context, tx pgx.Tx, tenantID uuid.UUID, aggregate, aggregateID, action string, revision *int, payload any, tombstone bool) error {
	defer observability.StartSegment(ctx, "Postgres.addTenantChange")()
	if tenantID == uuid.Nil {
		return domain.NewError(domain.CodeContextRequired, "Pilih usaha untuk melanjutkan")
	}
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))`, sandboxGenerationLock+":"+tenantID.String()); err != nil {
		return err
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO sync_changes (data_space_id, aggregate, aggregate_id, action, revision, payload, tombstone)
		SELECT ds.id, $1, $2,
		       CASE WHEN $6 OR ($1 = 'user' AND (NOT u.is_active OR u.deleted_at IS NOT NULL)) THEN 'deleted' ELSE $3 END,
		       $4,
		       CASE WHEN $1 = 'user' THEN jsonb_build_object(
		         'id',u.id,'fullName',u.full_name,'username',u.username,
		         'role', u.role, 'active', u.is_active AND u.deleted_at IS NULL,
		         'membershipId', m.id, 'tenantId', ds.tenant_id,
		         'mustChangePassword',u.must_change_password,'createdAt',u.created_at,'updatedAt',u.updated_at,'deletedAt',u.deleted_at)
		       ELSE $5::jsonb END,
		       $6 OR ($1 = 'user' AND (NOT u.is_active OR u.deleted_at IS NOT NULL))
		FROM data_spaces ds
		LEFT JOIN tenant_memberships m ON $1 = 'user' AND m.tenant_id = ds.tenant_id AND m.user_id = $8
		LEFT JOIN users u ON $1 = 'user' AND u.id = $8
		WHERE ds.tenant_id = $7 AND ds.status = 'active' AND (
		  ($1 = 'user' AND u.id IS NOT NULL) OR
		  ($1 = 'terminal' AND EXISTS (SELECT 1 FROM terminals t WHERE t.id = $8 AND t.tenant_id = ds.tenant_id)) OR
		  $1 IN ('tenant_profile','tenant_qris','tenant_metadata'))`,
		aggregate, aggregateID, action, revision, body, tombstone, tenantID, aggregateUUID(aggregateID),
	)
	return err
}

// aggregateUUID lets uuid-keyed lookups use their indexes. Aggregate IDs that
// are not UUIDs become NULL and match no row, as the former text cast did.
func aggregateUUID(aggregateID string) *uuid.UUID {
	id, err := uuid.Parse(aggregateID)
	if err != nil {
		return nil
	}
	return &id
}

func nullableJSON(value any) ([]byte, error) {
	if value == nil {
		return nil, nil
	}
	return json.Marshal(value)
}

func nilUUID(value uuid.UUID) any {
	if value == uuid.Nil {
		return nil
	}
	return value
}

func principalIdentity(principal domain.Principal) domain.MutationIdentity {
	return domain.MutationIdentity{
		OriginActorID:        principal.UserID,
		OriginSessionID:      principal.SessionID,
		TerminalID:           principal.TerminalID,
		SubmittedByActorID:   principal.UserID,
		SubmittedBySessionID: principal.SessionID,
		DataSpaceID:          principal.EffectiveDataSpaceID(),
		DataMode:             principal.EffectiveDataMode(),
		TenantID:             principal.TenantID,
	}
}

// lockMutationIdentity is the lifecycle serialization boundary for every
// business write, including idempotency replays. Identity fields are never
// rewritten: both the historical author and current submitter must still have
// access to this tenant and the exact originating enrollment.
func lockMutationIdentity(ctx context.Context, tx pgx.Tx, identity domain.MutationIdentity) (domain.Role, error) {
	defer observability.StartSegment(ctx, "Postgres.lockMutationIdentity")()
	return lockMutationIdentityWithTenantLock(ctx, tx, identity, false, false)
}

// consumeSession locks the submitting session FOR UPDATE instead of FOR SHARE,
// at the same point in the lock order, for callers that will revoke it.
func lockMutationIdentityWithTenantLock(ctx context.Context, tx pgx.Tx, identity domain.MutationIdentity, exclusive, consumeSession bool) (domain.Role, error) {
	defer observability.StartSegment(ctx, "Postgres.lockMutationIdentityWithTenantLock")()
	if identity.TenantID == uuid.Nil || identity.DataSpaceID == uuid.Nil || identity.OriginActorID == uuid.Nil || identity.SubmittedByActorID == uuid.Nil || identity.OriginSessionID == uuid.Nil || identity.SubmittedBySessionID == uuid.Nil {
		return "", domain.NewError(domain.CodeForbidden, "Pilih usaha yang aktif untuk melanjutkan")
	}
	actorIDs := []uuid.UUID{identity.OriginActorID}
	if identity.SubmittedByActorID != identity.OriginActorID {
		actorIDs = append(actorIDs, identity.SubmittedByActorID)
	}
	sort.Slice(actorIDs, func(i, j int) bool { return actorIDs[i].String() < actorIDs[j].String() })
	for _, actorID := range actorIDs {
		var active bool
		if err := tx.QueryRow(ctx, `SELECT is_active AND deleted_at IS NULL AND NOT must_change_password FROM users WHERE id = $1 FOR SHARE`, actorID).Scan(&active); err != nil {
			return "", dbError(err, "lock mutation account")
		}
		if !active {
			return "", domain.NewError(domain.CodeForbidden, "Akses akun asal atau pengirim tidak aktif. Data belum terkirim tetap disimpan")
		}
	}
	var tenantStatus string
	tenantLock := `SELECT status FROM tenants WHERE id = $1 FOR SHARE`
	if exclusive {
		tenantLock = `SELECT status FROM tenants WHERE id = $1 FOR UPDATE`
	}
	if err := tx.QueryRow(ctx, tenantLock, identity.TenantID).Scan(&tenantStatus); err != nil {
		return "", dbError(err, "lock mutation tenant")
	}
	if tenantStatus != "active" {
		return "", domain.NewError(domain.CodeTenantSuspended, "Usaha sedang dinonaktifkan. Data belum terkirim tetap disimpan")
	}
	var originRole domain.Role
	for _, actorID := range actorIDs {
		var role domain.Role
		if err := tx.QueryRow(ctx, `SELECT u.role FROM users u JOIN tenant_memberships m ON m.user_id=u.id WHERE m.tenant_id = $1 AND u.id = $2 FOR SHARE OF u,m`, identity.TenantID, actorID).Scan(&role); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return "", domain.NewError(domain.CodeMembershipInactive, "Identitas bisnis asal atau pengirim tidak tersedia. Data belum terkirim tetap disimpan")
			}
			return "", dbError(err, "lock mutation membership")
		}
		if actorID == identity.OriginActorID {
			originRole = role
		}
	}
	// Acquire generation before session/terminal locks. Reset revokes sessions
	// while holding its exclusive generation lock; the inverse order deadlocks.
	generationLock := `SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))`
	if exclusive {
		generationLock = `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`
	}
	if _, err := tx.Exec(ctx, generationLock, sandboxGenerationLock+":"+identity.TenantID.String()); err != nil {
		return "", dbError(err, "lock mutation generation")
	}
	var mode domain.DataMode
	var spaceStatus domain.DataSpaceStatus
	if err := tx.QueryRow(ctx, `SELECT mode,status FROM data_spaces WHERE id=$1 AND tenant_id=$2 FOR SHARE`, identity.DataSpaceID, identity.TenantID).Scan(&mode, &spaceStatus); err != nil {
		return "", dbError(err, "lock mutation data space")
	}
	if spaceStatus != domain.DataSpaceStatusActive {
		if mode == domain.DataModeSandbox {
			return "", domain.NewError(domain.CodeSandboxGenerationRetired, "Generasi Sandbox telah diganti. Muat ulang data Sandbox untuk melanjutkan")
		}
		return "", domain.NewError(domain.CodeForbidden, "Ruang data tidak aktif")
	}
	var matches bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (
		SELECT 1 FROM sessions origin
		JOIN sessions submitter ON submitter.id = $2
		JOIN data_spaces ds ON ds.id = origin.data_space_id AND ds.tenant_id = origin.tenant_id
		JOIN tenant_memberships om ON om.id = origin.membership_id AND om.tenant_id = origin.tenant_id AND om.user_id = origin.user_id
		JOIN tenant_memberships sm ON sm.id = submitter.membership_id AND sm.tenant_id = submitter.tenant_id AND sm.user_id = submitter.user_id
		WHERE origin.id = $1 AND origin.user_id = $3 AND submitter.user_id = $4
		  AND origin.context_kind = 'tenant' AND submitter.context_kind = 'tenant'
		  AND origin.tenant_id = $5 AND submitter.tenant_id = $5
		  AND origin.data_space_id = $6 AND submitter.data_space_id = $6
		  AND origin.terminal_id IS NOT DISTINCT FROM $7::uuid
		  AND submitter.terminal_id IS NOT DISTINCT FROM $7::uuid
		  AND submitter.revoked_at IS NULL
	)`, identity.OriginSessionID, identity.SubmittedBySessionID, identity.OriginActorID, identity.SubmittedByActorID, identity.TenantID, identity.DataSpaceID, identity.TerminalID).Scan(&matches); err != nil {
		return "", dbError(err, "validate mutation sessions")
	}
	if !matches {
		return "", domain.NewError(domain.CodeForbidden, "Identitas operasi tidak sesuai dengan usaha, sesi, atau terminal aktif")
	}
	var submitterActive bool
	sessionLock := `SELECT revoked_at IS NULL FROM sessions WHERE id = $1 FOR SHARE`
	if consumeSession {
		sessionLock = `SELECT revoked_at IS NULL FROM sessions WHERE id = $1 FOR UPDATE`
	}
	if err := tx.QueryRow(ctx, sessionLock, identity.SubmittedBySessionID).Scan(&submitterActive); err != nil {
		return "", dbError(err, "lock submitting session")
	}
	if !submitterActive {
		return "", domain.NewError(domain.CodeUnauthorized, "Sesi pengirim sudah berakhir. Masuk kembali untuk melanjutkan")
	}
	if identity.TerminalID != nil {
		var active bool
		if err := tx.QueryRow(ctx, `SELECT is_active AND revoked_at IS NULL FROM terminals WHERE id = $1 AND tenant_id = $2 FOR SHARE`, *identity.TerminalID, identity.TenantID).Scan(&active); err != nil {
			return "", dbError(err, "lock mutation terminal")
		}
		if !active {
			return "", domain.NewError(domain.CodeForbidden, "Terminal telah dicabut. Data belum terkirim tetap disimpan")
		}
	}
	return originRole, nil
}

func lockTenantAccess(ctx context.Context, tx pgx.Tx, principal domain.Principal) (domain.Role, error) {
	defer observability.StartSegment(ctx, "Postgres.lockTenantAccess")()
	if principal.ContextKind != domain.ContextTenant || principal.MembershipID == uuid.Nil {
		return "", domain.NewError(domain.CodeContextRequired, "Pilih usaha yang aktif untuk melanjutkan")
	}
	return lockMutationIdentity(ctx, tx, principalIdentity(principal))
}

// lockTenantSessionForReplacement is lockTenantAccess for callers that revoke
// the current session. Taking the exclusive row lock up front makes concurrent
// replacements queue; a share lock upgraded later deadlocks between them.
func lockTenantSessionForReplacement(ctx context.Context, tx pgx.Tx, principal domain.Principal) (domain.Role, error) {
	defer observability.StartSegment(ctx, "Postgres.lockTenantSessionForReplacement")()
	if principal.ContextKind != domain.ContextTenant || principal.MembershipID == uuid.Nil {
		return "", domain.NewError(domain.CodeContextRequired, "Pilih usaha yang aktif untuk melanjutkan")
	}
	return lockMutationIdentityWithTenantLock(ctx, tx, principalIdentity(principal), false, true)
}

func lockTenantLifecycleAccess(ctx context.Context, tx pgx.Tx, principal domain.Principal) (domain.Role, error) {
	defer observability.StartSegment(ctx, "Postgres.lockTenantLifecycleAccess")()
	if !principal.IsTenantContext() || principal.MembershipID == uuid.Nil {
		return "", domain.NewError(domain.CodeContextRequired, "Pilih usaha yang aktif untuk melanjutkan")
	}
	return lockMutationIdentityWithTenantLock(ctx, tx, principalIdentity(principal), true, false)
}
