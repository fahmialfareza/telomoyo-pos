package postgres

import (
	"context"
	"crypto/subtle"

	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/domain"
	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/observability"
	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/port"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

var _ port.SessionPolicyRepository = (*Store)(nil)
var _ port.VerifiedLoginSessionRepository = (*Store)(nil)
var _ port.PasswordHashUpgradeRepository = (*Store)(nil)

// UpgradePasswordHash swaps only the exact hash that was verified, so a
// concurrent password change or recovery always wins. Sessions, updated_at and
// sync state are left alone because the credential itself is unchanged.
func (s *Store) UpgradePasswordHash(ctx context.Context, userID uuid.UUID, verifiedHash, upgradedHash string) error {
	defer observability.StartSegment(ctx, "Postgres.UpgradePasswordHash")()
	_, err := s.Pool.Exec(ctx, `UPDATE users SET password_hash=$3 WHERE id=$1 AND password_hash=$2 AND is_active AND deleted_at IS NULL`,
		userID, verifiedHash, upgradedHash)
	return dbError(err, "upgrade password hash")
}

// CreateVerifiedLoginSession serializes credential verification with password
// changes/recovery and account deactivation. Expensive password hashing is done
// before entering this transaction; the exact verified hash is checked again
// while the account lock is held until the new session commits.
func (s *Store) CreateVerifiedLoginSession(ctx context.Context, input port.VerifiedLoginSession) (principal domain.Principal, err error) {
	defer observability.StartSegment(ctx, "Postgres.CreateVerifiedLoginSession")()
	err = s.controlTx(ctx, func(tx pgx.Tx) error {
		var active bool
		var currentHash string
		if err := tx.QueryRow(ctx, `SELECT is_active AND deleted_at IS NULL,password_hash FROM users WHERE id=$1 FOR SHARE`, input.UserID).Scan(&active, &currentHash); err != nil {
			if err == pgx.ErrNoRows {
				return domain.NewError(domain.CodeInvalidCredentials, "Username atau kata sandi salah")
			}
			return err
		}
		if !active || input.VerifiedPasswordHash == "" || subtle.ConstantTimeCompare([]byte(currentHash), []byte(input.VerifiedPasswordHash)) != 1 {
			return domain.NewError(domain.CodeInvalidCredentials, "Username atau kata sandi salah")
		}
		protocol := domain.NegotiatedClientProtocolVersion(input.ProtocolVersion)
		if input.DataSpaceID == uuid.Nil {
			var err error
			principal, err = createAccountSessionWithProtocol(ctx, tx, input.UserID, input.TokenHash, protocol)
			return err
		}
		// Pre-context clients can only log into the migrated tenant's Production
		// space. Never treat caller-supplied legacy scope as a tenant selector.
		var tenantID uuid.UUID
		if err := tx.QueryRow(ctx, `SELECT tenant_id FROM data_spaces WHERE id=$1`, input.DataSpaceID).Scan(&tenantID); err != nil {
			return err
		}
		if tenantID != domain.InitialTenantID() {
			return domain.NewError(domain.CodeContextRequired, "Pilih bisnis melalui aplikasi terbaru")
		}
		var tenantStatus string
		if err := tx.QueryRow(ctx, `SELECT status FROM tenants WHERE id=$1 FOR SHARE`, tenantID).Scan(&tenantStatus); err != nil {
			return err
		}
		if tenantStatus != "active" {
			return domain.NewError(domain.CodeTenantSuspended, "Bisnis sedang dinonaktifkan")
		}
		membershipID, err := ensureAccountTenantLink(ctx, tx, tenantID, input.UserID)
		if err != nil {
			return err
		}
		space, err := lockActiveDataSpace(ctx, tx, input.DataSpaceID)
		if err != nil {
			return err
		}
		if space.Mode != domain.DataModeProduction {
			return domain.NewError(domain.CodeContextRequired, "Masuk kembali melalui mode produksi")
		}
		if input.TerminalID != nil {
			var active bool
			if err := tx.QueryRow(ctx, `SELECT is_active AND revoked_at IS NULL FROM terminals WHERE id=$1 AND tenant_id=$2 FOR SHARE`, *input.TerminalID, tenantID).Scan(&active); err != nil || !active {
				return domain.NewError(domain.CodeForbidden, "Terminal tidak aktif. Hubungi Superadmin")
			}
		}
		var id uuid.UUID
		if err := tx.QueryRow(ctx, `INSERT INTO sessions(user_id,terminal_id,token_hash,data_space_id,tenant_id,membership_id,context_kind,legacy_origin,protocol_version,sandbox_qris_policy)
		 VALUES($1,$2,$3,$4,$5,$6,'tenant',false,$7,$8) RETURNING id`, input.UserID, input.TerminalID, input.TokenHash, space.ID, tenantID, membershipID, protocol, domain.SandboxQRISPolicyForProtocol(protocol)).Scan(&id); err != nil {
			return err
		}
		principal, err = principalBySessionRow(ctx, tx, id, input.TokenHash)
		return err
	})
	return
}

func (s *Store) CreateAccountSessionWithProtocol(ctx context.Context, userID uuid.UUID, hash []byte, protocol int) (principal domain.Principal, err error) {
	defer observability.StartSegment(ctx, "Postgres.CreateAccountSessionWithProtocol")()
	protocol = domain.NegotiatedClientProtocolVersion(protocol)
	err = s.controlTx(ctx, func(tx pgx.Tx) error {
		var active bool
		if err := tx.QueryRow(ctx, `SELECT is_active AND deleted_at IS NULL FROM users WHERE id=$1 FOR SHARE`, userID).Scan(&active); err != nil {
			return err
		}
		if !active {
			return domain.NewError(domain.CodeUnauthorized, "Akun tidak aktif")
		}
		var err error
		principal, err = createAccountSessionWithProtocol(ctx, tx, userID, hash, protocol)
		return err
	})
	return
}

func createAccountSessionWithProtocol(ctx context.Context, tx pgx.Tx, userID uuid.UUID, hash []byte, protocol int) (domain.Principal, error) {
	defer observability.StartSegment(ctx, "Postgres.createAccountSessionWithProtocol")()
	var id uuid.UUID
	if err := tx.QueryRow(ctx, `INSERT INTO sessions(user_id,token_hash,context_kind,data_space_id,tenant_id,membership_id,legacy_origin,protocol_version,sandbox_qris_policy)
	 VALUES($1,$2,'account',NULL,NULL,NULL,false,$3,$4) RETURNING id`, userID, hash, protocol, domain.SandboxQRISPolicyForProtocol(protocol)).Scan(&id); err != nil {
		return domain.Principal{}, err
	}
	return principalBySessionRow(ctx, tx, id, hash)
}

// UpgradeSession revalidates the current scope under the same lifecycle locks as
// mutations. Source identity is copied from the locked row, never caller input.
func (s *Store) UpgradeSession(ctx context.Context, current domain.Principal, currentHash, replacementHash []byte, protocol int) (principal domain.Principal, err error) {
	defer observability.StartSegment(ctx, "Postgres.UpgradeSession")()
	if protocol != domain.CurrentClientProtocolVersion {
		return principal, domain.Validation("Versi protokol pembaruan sesi tidak didukung", nil)
	}
	err = s.controlTx(ctx, func(tx pgx.Tx) error {
		if current.ContextKind == domain.ContextTenant {
			if _, err := lockTenantAccess(ctx, tx, current); err != nil {
				return err
			}
		} else if current.ContextKind == domain.ContextAccount || current.ContextKind == domain.ContextPlatform {
			var active bool
			if err := tx.QueryRow(ctx, `SELECT is_active AND deleted_at IS NULL FROM users WHERE id=$1 FOR SHARE`, current.UserID).Scan(&active); err != nil {
				return err
			}
			if !active {
				return domain.NewError(domain.CodeUnauthorized, "Akun tidak aktif")
			}
		} else {
			return domain.NewError(domain.CodeUnauthorized, "Sesi tidak valid")
		}
		var oldProtocol int
		if err := tx.QueryRow(ctx, `SELECT protocol_version FROM sessions WHERE id=$1 AND user_id=$2 AND token_hash=$3 AND context_kind=$4 AND revoked_at IS NULL FOR UPDATE`, current.SessionID, current.UserID, currentHash, current.ContextKind).Scan(&oldProtocol); err != nil {
			return domain.NewError(domain.CodeUnauthorized, "Sesi telah berubah. Masuk kembali")
		}
		if oldProtocol > protocol {
			return domain.Validation("Sesi tidak dapat diturunkan ke protokol lama", nil)
		}
		var id uuid.UUID
		if err := tx.QueryRow(ctx, `INSERT INTO sessions(user_id,token_hash,context_kind,data_space_id,tenant_id,membership_id,terminal_id,legacy_origin,protocol_version,sandbox_qris_policy)
		 SELECT user_id,$2,CASE WHEN context_kind='platform' THEN 'account' ELSE context_kind END,data_space_id,tenant_id,membership_id,terminal_id,false,$3,$4
		 FROM sessions WHERE id=$1 RETURNING id`, current.SessionID, replacementHash, protocol, domain.SandboxQRISPolicyForProtocol(protocol)).Scan(&id); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE sessions SET revoked_at=now(),revoked_reason='session_upgraded' WHERE id=$1`, current.SessionID); err != nil {
			return err
		}
		if err := controlAudit(ctx, tx, &current.UserID, nil, "account.session_upgraded", map[string]any{"protocolVersion": protocol, "sandboxQrisPolicy": domain.SandboxQRISPolicyForProtocol(protocol)}); err != nil {
			return err
		}
		var err error
		principal, err = principalBySessionRow(ctx, tx, id, replacementHash)
		return err
	})
	return
}

// originSandboxQRISPolicy is only called after lockMutationIdentity. Policy is
// immutable, so reading the exact signed origin cannot race a session exchange.
func originSandboxQRISPolicy(ctx context.Context, query rowQuerier, identity domain.MutationIdentity) (domain.SandboxQRISPolicy, error) {
	defer observability.StartSegment(ctx, "Postgres.originSandboxQRISPolicy")()
	var policy domain.SandboxQRISPolicy
	err := query.QueryRow(ctx, `SELECT sandbox_qris_policy FROM sessions WHERE id=$1 AND user_id=$2 AND tenant_id=$3 AND data_space_id=$4 AND context_kind='tenant'`, identity.OriginSessionID, identity.OriginActorID, identity.TenantID, identity.DataSpaceID).Scan(&policy)
	if err != nil {
		return "", dbError(err, "read origin Sandbox payment policy")
	}
	if !policy.Valid() {
		return "", domain.NewError(domain.CodeClientUpdateRequired, "Kebijakan pembayaran sesi tidak didukung. Perbarui aplikasi dan server")
	}
	return policy, nil
}
