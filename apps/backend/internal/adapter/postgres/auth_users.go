package postgres

import (
	"context"

	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/domain"
	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/observability"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (s *Store) UserForLogin(ctx context.Context, username string) (domain.UserAuth, error) {
	defer observability.StartSegment(ctx, "Postgres.UserForLogin")()
	var record userRecord
	err := s.ORM.WithContext(ctx).
		Where("username = ?", username).
		Take(&record).Error
	return domain.UserAuth{
		User:         record.domainUser(),
		PasswordHash: record.PasswordHash,
	}, dbError(err, "find login user")
}

func (s *Store) CreateSession(ctx context.Context, userID uuid.UUID, terminalID *uuid.UUID, tokenHash []byte, dataSpaceID uuid.UUID) (domain.Principal, error) {
	defer observability.StartSegment(ctx, "Postgres.CreateSession")()
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return domain.Principal{}, dbError(err, "begin session")
	}
	defer tx.Rollback(ctx)
	var tenantID uuid.UUID
	if err = tx.QueryRow(ctx, `SELECT tenant_id FROM data_spaces WHERE id=$1`, dataSpaceID).Scan(&tenantID); err != nil {
		return domain.Principal{}, dbError(err, "find session tenant")
	}
	if _, err = ensureAccountTenantLink(ctx, tx, tenantID, userID); err != nil {
		return domain.Principal{}, dbError(err, "link account tenant")
	}

	if terminalID != nil {
		var active bool
		if err = tx.QueryRow(ctx,
			`SELECT t.is_active AND t.revoked_at IS NULL FROM terminals t
			 JOIN data_spaces ds ON ds.tenant_id = t.tenant_id WHERE t.id = $1 AND ds.id = $2`,
			*terminalID, dataSpaceID,
		).Scan(&active); err != nil || !active {
			if err == nil {
				err = domain.NewError(domain.CodeForbidden, "Terminal tidak aktif")
			}
			return domain.Principal{}, dbError(err, "validate terminal")
		}
	}
	var sessionID uuid.UUID
	err = tx.QueryRow(ctx, `
		INSERT INTO sessions (user_id, terminal_id, token_hash, data_space_id, tenant_id, membership_id, context_kind, legacy_origin)
		SELECT $1,$2,$3,ds.id,ds.tenant_id,m.id,'tenant',false
		FROM data_spaces ds
		JOIN tenants t ON t.id = ds.tenant_id AND t.status = 'active'
		JOIN tenant_memberships m ON m.tenant_id = ds.tenant_id AND m.user_id = $1
		WHERE ds.id = $4 AND ds.status = 'active'
		RETURNING id`,
		userID, terminalID, tokenHash, domain.EffectiveDataSpaceID(dataSpaceID),
	).Scan(&sessionID)
	if err != nil {
		return domain.Principal{}, dbError(err, "create session")
	}
	principal, err := principalBySessionRow(ctx, tx, sessionID, tokenHash)
	if err != nil {
		return domain.Principal{}, dbError(err, "read created session")
	}
	if err = tx.Commit(ctx); err != nil {
		return domain.Principal{}, dbError(err, "commit session")
	}
	return principal, nil
}

func (s *Store) PrincipalByTokenHash(ctx context.Context, tokenHash []byte) (domain.Principal, error) {
	defer observability.StartSegment(ctx, "Postgres.PrincipalByTokenHash")()
	var sessionID uuid.UUID
	if err := s.Pool.QueryRow(ctx,
		`SELECT id FROM sessions WHERE token_hash = $1`,
		tokenHash,
	).Scan(&sessionID); err != nil {
		return domain.Principal{}, dbError(err, "find session token")
	}
	return s.PrincipalBySession(ctx, sessionID, tokenHash)
}

func (s *Store) PrincipalBySession(ctx context.Context, sessionID uuid.UUID, tokenHash []byte) (domain.Principal, error) {
	defer observability.StartSegment(ctx, "Postgres.PrincipalBySession")()
	principal, err := principalBySessionRow(ctx, s.Pool, sessionID, tokenHash)
	return principal, dbError(err, "authorize session")
}

type rowQuerier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func principalBySessionRow(ctx context.Context, query rowQuerier, sessionID uuid.UUID, tokenHash []byte) (domain.Principal, error) {
	defer observability.StartSegment(ctx, "Postgres.principalBySessionRow")()
	var principal domain.Principal
	var tenant domain.Tenant
	var membershipStatus, spaceStatus string
	var retired bool
	var revokedReason string
	var terminalActive, accountActive bool
	err := query.QueryRow(ctx, `
		SELECT u.id, s.id, s.terminal_id, u.full_name, u.username, u.role, u.must_change_password,
		       COALESCE(ds.id,'00000000-0000-0000-0000-000000000000'), COALESCE(ds.mode,''),
		       CASE WHEN ds.mode = 'sandbox' THEN ds.generation ELSE 0 END,
		       s.context_kind, COALESCE(s.tenant_id,'00000000-0000-0000-0000-000000000000'),
		       COALESCE(s.membership_id,'00000000-0000-0000-0000-000000000000'),
		       false, s.legacy_origin,s.protocol_version,s.sandbox_qris_policy,
		       COALESCE(t.name,''), COALESCE(t.slug,''), COALESCE(t.status,''), COALESCE(t.profile_revision,0),t.qris_revision,COALESCE(t.management_revision,0),
		       t.sandbox_enabled_override,
		       COALESCE(m.status,''),COALESCE(ds.status,''),s.revoked_at IS NOT NULL,
		       COALESCE(s.revoked_reason,''),u.created_at,u.updated_at,u.is_active AND u.deleted_at IS NULL,
		       s.terminal_id IS NULL OR EXISTS(SELECT 1 FROM terminals term WHERE term.id=s.terminal_id AND term.tenant_id=s.tenant_id AND term.is_active AND term.revoked_at IS NULL)
		FROM sessions s
		JOIN users u ON u.id = s.user_id
		LEFT JOIN tenant_memberships m ON m.id = s.membership_id AND m.user_id=s.user_id AND m.tenant_id=s.tenant_id
		LEFT JOIN data_spaces ds ON ds.id = s.data_space_id AND ds.tenant_id=s.tenant_id
		LEFT JOIN tenants t ON t.id=s.tenant_id
		WHERE s.id = $1 AND s.token_hash = $2
		  AND (s.revoked_at IS NULL OR s.revoked_reason IN ('membership_changed','tenant_suspended','terminal_revoked','account_access_changed','password_recovered') OR (s.revoked_reason='sandbox_generation_retired'
		       AND ds.mode='sandbox' AND ds.status='retired' AND s.revoked_at=ds.retired_at))
		`,
		sessionID, tokenHash,
	).Scan(
		&principal.UserID, &principal.SessionID, &principal.TerminalID,
		&principal.FullName, &principal.Username, &principal.Role, &principal.MustChangePassword,
		&principal.DataSpaceID, &principal.DataMode, &principal.SandboxGeneration,
		&principal.ContextKind, &principal.TenantID, &principal.MembershipID,
		&principal.IsPlatformAdmin, &principal.LegacyOrigin, &principal.ProtocolVersion, &principal.SandboxQRISPolicy,
		&tenant.Name, &tenant.Slug, &tenant.Status, &tenant.ProfileRevision, &tenant.QrisRevision, &tenant.Revision,
		&principal.SandboxEnabledOverride,
		&membershipStatus, &spaceStatus, &retired,
		&revokedReason, &principal.UserCreatedAt, &principal.UserUpdatedAt, &accountActive, &terminalActive,
	)
	if err != nil {
		return principal, err
	}
	if !accountActive || revokedReason == "account_access_changed" || revokedReason == "password_recovered" {
		return principal, domain.NewError(domain.CodeAccountAccessChanged, "Akses akun telah berubah. Data belum tersinkron tetap disimpan. Masuk kembali atau hubungi Superadmin")
	}
	if principal.ContextKind == domain.ContextTenant {
		tenant.ID = principal.TenantID
		principal.Tenant = &tenant
		if tenant.Status != "active" {
			return principal, domain.NewError(domain.CodeTenantSuspended, "Bisnis sedang dinonaktifkan. Hubungi Superadmin")
		}
		if revokedReason == "membership_changed" || revokedReason == "tenant_suspended" || revokedReason == "terminal_revoked" || !terminalActive {
			return principal, domain.NewError(domain.CodeMembershipInactive, "Akses bisnis atau terminal telah berubah. Pilih bisnis kembali untuk melanjutkan")
		}
		if retired {
			return principal, domain.NewError(domain.CodeSandboxGenerationRetired, "Generasi Sandbox telah diganti. Muat ulang data Sandbox untuk melanjutkan")
		}
		if spaceStatus != "active" {
			return domain.Principal{}, domain.NewError(domain.CodeUnauthorized, "Ruang data tidak aktif")
		}
	}
	if principal.TerminalID != nil {
		terminal, loadErr := terminalByID(ctx, query, principal.TenantID, *principal.TerminalID)
		if loadErr != nil {
			return principal, loadErr
		}
		principal.Terminal = &terminal
	}
	return principal, err
}

func (s *Store) RevokeSession(ctx context.Context, sessionID, actorID uuid.UUID, reason string) error {
	defer observability.StartSegment(ctx, "Postgres.RevokeSession")()
	tag, err := s.Pool.Exec(ctx, `
		UPDATE sessions
		SET revoked_at = now(), revoked_reason = $2
		WHERE id = $1 AND revoked_at IS NULL`,
		sessionID, reason,
	)
	if err != nil {
		return dbError(err, "revoke session")
	}
	if tag.RowsAffected() == 0 {
		return domain.NewError(domain.CodeNotFound, "Sesi tidak ditemukan")
	}
	return nil
}

func (s *Store) ChangeOwnPassword(ctx context.Context, principal domain.Principal, passwordHash string) error {
	defer observability.StartSegment(ctx, "Postgres.ChangeOwnPassword")()
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return dbError(err, "begin password change")
	}
	defer tx.Rollback(ctx)
	if err = lockOwnAccount(ctx, tx, principal, true); err != nil {
		return dbError(err, "authorize password change")
	}
	tag, err := tx.Exec(ctx, `
		UPDATE users
		SET password_hash = $2, must_change_password = false, updated_at = now()
		WHERE id = $1 AND is_active AND deleted_at IS NULL`,
		principal.UserID, passwordHash,
	)
	if err != nil || tag.RowsAffected() != 1 {
		if err == nil {
			err = pgx.ErrNoRows
		}
		return dbError(err, "change password")
	}
	_, err = tx.Exec(ctx, `
		UPDATE sessions
		SET revoked_at = now(), revoked_reason = 'password_changed'
		WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`,
		principal.UserID, principal.SessionID,
	)
	if err != nil {
		return dbError(err, "revoke other sessions")
	}
	if err = controlAudit(ctx, tx, &principal.UserID, nil, "account.password_changed", map[string]any{"mustChangePassword": false}); err != nil {
		return dbError(err, "audit password change")
	}
	if err = addSharedChange(ctx, tx, "user", principal.UserID.String(), "updated", nil,
		map[string]any{"id": principal.UserID, "mustChangePassword": false}, false); err != nil {
		return dbError(err, "sync password change")
	}
	return dbError(tx.Commit(ctx), "commit password change")
}

func (s *Store) ListUsers(ctx context.Context, tenantID uuid.UUID, includeDeleted bool) ([]domain.User, error) {
	defer observability.StartSegment(ctx, "Postgres.ListUsers")()
	if tenantID == uuid.Nil {
		return nil, domain.NewError(domain.CodeContextRequired, "Pilih bisnis untuk melanjutkan")
	}
	query := s.ORM.WithContext(ctx).Table("users u").
		Select("u.id, u.full_name, u.username, u.role, u.is_active, u.must_change_password, u.created_at, u.updated_at, u.deleted_at")
	if !includeDeleted {
		query = query.Where("u.deleted_at IS NULL")
	}
	var records []userRecord
	if err := query.Order("u.full_name, u.id").Scan(&records).Error; err != nil {
		return nil, dbError(err, "list users")
	}
	users := make([]domain.User, 0, len(records))
	for _, record := range records {
		users = append(users, record.domainUser())
	}
	return users, nil
}

func (s *Store) GetUser(ctx context.Context, tenantID, id uuid.UUID) (domain.User, error) {
	defer observability.StartSegment(ctx, "Postgres.GetUser")()
	if tenantID == uuid.Nil {
		return domain.User{}, domain.NewError(domain.CodeContextRequired, "Pilih bisnis untuk melanjutkan")
	}
	user, err := scanAccountUser(s.Pool.QueryRow(ctx, `SELECT u.id,u.full_name,u.username,u.role,
	 u.is_active,u.must_change_password,u.created_at,u.updated_at,u.deleted_at
	 FROM users u WHERE u.id=$1`, id))
	return user, dbError(err, "read tenant member")
}

// Obsolete global staff mutations are disabled even for direct repository callers.
// Obsolete tenant-level user requests must never become global account edits.
func (s *Store) CreateUser(ctx context.Context, actor domain.Principal, input domain.CreateUserInput, passwordHash string) (domain.User, error) {
	defer observability.StartSegment(ctx, "Postgres.CreateUser")()
	return domain.User{}, legacyUsersDisabled()
}
func (s *Store) UpdateUser(ctx context.Context, actor domain.Principal, targetID uuid.UUID, input domain.UpdateUserInput) (domain.User, error) {
	defer observability.StartSegment(ctx, "Postgres.UpdateUser")()
	return domain.User{}, legacyUsersDisabled()
}
func (s *Store) ResetUserPassword(ctx context.Context, actor domain.Principal, targetID uuid.UUID, passwordHash string) (domain.User, error) {
	defer observability.StartSegment(ctx, "Postgres.ResetUserPassword")()
	return domain.User{}, legacyUsersDisabled()
}
func (s *Store) DeleteUser(ctx context.Context, actor domain.Principal, targetID uuid.UUID, reason string) error {
	defer observability.StartSegment(ctx, "Postgres.DeleteUser")()
	return legacyUsersDisabled()
}
func legacyUsersDisabled() error {
	return domain.NewError(domain.CodeClientUpdateRequired, "Perbarui aplikasi dan gunakan Pengguna pada pengelolaan organisasi untuk mengelola akun")
}
