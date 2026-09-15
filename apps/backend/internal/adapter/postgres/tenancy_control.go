package postgres

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/domain"
	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/observability"
	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/port"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

var _ port.TenancyRepository = (*Store)(nil)

func (s *Store) controlTx(ctx context.Context, run func(pgx.Tx) error) error {
	defer observability.StartSegment(ctx, "Postgres.controlTx")()
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return dbError(err, "begin tenant control")
	}
	defer tx.Rollback(ctx)
	if err = run(tx); err != nil {
		return dbError(err, "tenant control")
	}
	return dbError(tx.Commit(ctx), "commit tenant control")
}

func controlAudit(ctx context.Context, tx pgx.Tx, actorID *uuid.UUID, tenantID *uuid.UUID, event string, metadata any) error {
	defer observability.StartSegment(ctx, "Postgres.controlAudit")()
	body, err := json.Marshal(metadata)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO platform_audit_events(event_type,actor_id,tenant_id,metadata) VALUES($1,$2,$3,$4)`, event, actorID, tenantID, body)
	return err
}

func lockControlAccount(ctx context.Context, tx pgx.Tx, actor domain.Principal, platform bool) error {
	defer observability.StartSegment(ctx, "Postgres.lockControlAccount")()
	var active, admin, mustChange bool
	err := tx.QueryRow(ctx, `SELECT is_active AND deleted_at IS NULL,role='superadmin',must_change_password FROM users WHERE id=$1 FOR SHARE`, actor.UserID).Scan(&active, &admin, &mustChange)
	if err != nil {
		return err
	}
	if !active || platform && (!admin || (actor.ContextKind != domain.ContextAccount && actor.ContextKind != domain.ContextTenant)) {
		return domain.NewError(domain.CodeForbidden, "Masuk ke pengelolaan organisasi sebagai Superadmin")
	}
	if mustChange {
		return domain.NewError(domain.CodePasswordChange, "Ganti kata sandi sementara sebelum melanjutkan")
	}
	return validateControlSession(ctx, tx, actor, false)
}

func validateControlSession(ctx context.Context, tx pgx.Tx, actor domain.Principal, recovery bool) error {
	defer observability.StartSegment(ctx, "Postgres.validateControlSession")()
	var valid bool
	err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM sessions WHERE id=$1 AND user_id=$2 AND context_kind=$3
	 AND (revoked_at IS NULL OR ($4 AND revoked_reason IN ('membership_changed','tenant_suspended','terminal_revoked'))))`, actor.SessionID, actor.UserID, actor.ContextKind, recovery).Scan(&valid)
	if err != nil {
		return err
	}
	if !valid {
		return domain.NewError(domain.CodeUnauthorized, "Sesi telah berubah. Masuk kembali")
	}
	return nil
}

func lockTenantOwner(ctx context.Context, tx pgx.Tx, actor domain.Principal) error {
	defer observability.StartSegment(ctx, "Postgres.lockTenantOwner")()
	if !actor.IsTenantContext() || actor.MembershipID == uuid.Nil || actor.DataMode != domain.DataModeProduction {
		return domain.NewError(domain.CodeForbidden, "Pilih mode produksi bisnis untuk melanjutkan")
	}
	if err := lockControlAccount(ctx, tx, actor, false); err != nil {
		return err
	}
	var status string
	// Control mutations serialize on the tenant before locking memberships. Never
	// upgrade a shared tenant lock after locking a resource: two owners can deadlock.
	if err := tx.QueryRow(ctx, `SELECT status FROM tenants WHERE id=$1 FOR NO KEY UPDATE`, actor.TenantID).Scan(&status); err != nil {
		return err
	}
	if status != "active" {
		return domain.NewError(domain.CodeTenantSuspended, "Bisnis sedang dinonaktifkan")
	}
	var role domain.Role
	if err := tx.QueryRow(ctx, `SELECT u.role FROM users u JOIN tenant_memberships m ON m.user_id=u.id WHERE m.id=$1 AND m.tenant_id=$2 AND u.id=$3 FOR SHARE OF u,m`, actor.MembershipID, actor.TenantID, actor.UserID).Scan(&role); err != nil {
		return err
	}
	if role != domain.RoleSuperadmin {
		return domain.NewError(domain.CodeForbidden, "Tindakan ini hanya tersedia untuk superadmin bisnis")
	}
	var valid bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM data_spaces ds WHERE ds.id=$1 AND ds.tenant_id=$2 AND ds.mode='production' AND ds.status='active')
	 AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM terminals WHERE id=$3 AND tenant_id=$2 AND is_active AND revoked_at IS NULL))`, actor.DataSpaceID, actor.TenantID, actor.TerminalID).Scan(&valid); err != nil {
		return err
	}
	if !valid {
		return domain.NewError(domain.CodeMembershipInactive, "Akses bisnis atau terminal telah berubah. Pilih bisnis kembali")
	}
	if err := validateControlSession(ctx, tx, actor, false); err != nil {
		return err
	}
	return nil
}

func scanTenant(row pgx.Row) (domain.Tenant, error) {
	var t domain.Tenant
	err := row.Scan(&t.ID, &t.Name, &t.Slug, &t.Status, &t.ProfileRevision, &t.QrisRevision, &t.Revision)
	return t, err
}

func (s *Store) AccountUser(ctx context.Context, id uuid.UUID) (domain.User, error) {
	defer observability.StartSegment(ctx, "Postgres.AccountUser")()
	user, err := scanAccountUser(s.Pool.QueryRow(ctx, `SELECT id,full_name,username,role,is_active,must_change_password,created_at,updated_at,deleted_at FROM users WHERE id=$1`, id))
	return user, dbError(err, "read own account")
}

func scanAccountUser(row pgx.Row) (user domain.User, err error) {
	err = row.Scan(&user.ID, &user.FullName, &user.Username, &user.Role, &user.IsActive, &user.MustChangePassword, &user.CreatedAt, &user.UpdatedAt, &user.DeletedAt)
	return
}

func (s *Store) CreateAccountSession(ctx context.Context, userID uuid.UUID, hash []byte) (principal domain.Principal, err error) {
	defer observability.StartSegment(ctx, "Postgres.CreateAccountSession")()
	err = s.controlTx(ctx, func(tx pgx.Tx) error {
		var active bool
		if e := tx.QueryRow(ctx, `SELECT is_active AND deleted_at IS NULL FROM users WHERE id=$1 FOR SHARE`, userID).Scan(&active); e != nil {
			return e
		}
		if !active {
			return domain.NewError(domain.CodeUnauthorized, "Akun tidak aktif")
		}
		var id uuid.UUID
		if e := tx.QueryRow(ctx, `INSERT INTO sessions(user_id,token_hash,context_kind,data_space_id,tenant_id,membership_id,legacy_origin) SELECT id,$2,'account',NULL,NULL,NULL,false FROM users WHERE id=$1 AND is_active AND deleted_at IS NULL RETURNING id`, userID, hash).Scan(&id); e != nil {
			return e
		}
		var e error
		principal, e = principalBySessionRow(ctx, tx, id, hash)
		return e
	})
	return
}

func (s *Store) AvailableContexts(ctx context.Context, userID uuid.UUID) (domain.AvailableContexts, error) {
	defer observability.StartSegment(ctx, "Postgres.AvailableContexts")()
	result := domain.AvailableContexts{Tenants: []domain.TenantContext{}}
	if err := s.Pool.QueryRow(ctx, `SELECT role='superadmin' FROM users WHERE id=$1 AND is_active AND deleted_at IS NULL`, userID).Scan(&result.CanManageOrganization); err != nil {
		return result, dbError(err, "load account contexts")
	}
	rows, err := s.Pool.Query(ctx, `SELECT t.id,t.name,t.slug,t.status,t.profile_revision,t.qris_revision,t.management_revision,COALESCE(m.id,'00000000-0000-0000-0000-000000000000'),u.role
	 FROM users u CROSS JOIN tenants t LEFT JOIN tenant_memberships m ON m.tenant_id=t.id AND m.user_id=u.id
	 WHERE u.id=$1 AND u.is_active AND u.deleted_at IS NULL AND t.status='active' ORDER BY t.name,t.id`, userID)
	if err != nil {
		return result, dbError(err, "list tenant contexts")
	}
	defer rows.Close()
	for rows.Next() {
		var c domain.TenantContext
		if err = rows.Scan(&c.Tenant.ID, &c.Tenant.Name, &c.Tenant.Slug, &c.Tenant.Status, &c.Tenant.ProfileRevision, &c.Tenant.QrisRevision, &c.Tenant.Revision, &c.MembershipID, &c.Role); err != nil {
			return result, err
		}
		result.Tenants = append(result.Tenants, c)
	}
	return result, dbError(rows.Err(), "read tenant contexts")
}

func (s *Store) SwitchContextSession(ctx context.Context, current domain.Principal, currentHash, replacementHash []byte, input domain.SwitchContextInput) (next domain.Principal, err error) {
	defer observability.StartSegment(ctx, "Postgres.SwitchContextSession")()
	err = s.controlTx(ctx, func(tx pgx.Tx) error {
		var active bool
		if e := tx.QueryRow(ctx, `SELECT is_active AND deleted_at IS NULL AND NOT must_change_password FROM users WHERE id=$1 FOR SHARE`, current.UserID).Scan(&active); e != nil {
			return e
		}
		if !active {
			return domain.NewError(domain.CodeUnauthorized, "Akun belum dapat beralih konteks")
		}
		if e := validateControlSession(ctx, tx, current, true); e != nil {
			return e
		}
		var tenantID, membershipID, spaceID, terminalID *uuid.UUID
		switch input.Kind {
		case domain.ContextAccount:
		case domain.ContextPlatform:
			return domain.NewError(domain.CodeClientUpdateRequired, "Perbarui aplikasi untuk pengelolaan organisasi melalui akun Superadmin")
		case domain.ContextTenant:
			var status string
			if e := tx.QueryRow(ctx, `SELECT status FROM tenants WHERE id=$1 FOR SHARE`, input.TenantID).Scan(&status); e != nil {
				return e
			}
			if status != "active" {
				return domain.NewError(domain.CodeTenantSuspended, "Bisnis belum aktif atau sedang dinonaktifkan")
			}
			var member, space uuid.UUID
			var e error
			member, e = ensureAccountTenantLink(ctx, tx, input.TenantID, current.UserID)
			if e != nil {
				return e
			}
			if e := tx.QueryRow(ctx, `SELECT id FROM data_spaces WHERE tenant_id=$1 AND mode='production' AND status='active'`, input.TenantID).Scan(&space); e != nil {
				return e
			}
			tenantID = &input.TenantID
			membershipID = &member
			spaceID = &space
			if input.InstallationID != nil {
				var terminal uuid.UUID
				e := tx.QueryRow(ctx, `SELECT id FROM terminals WHERE tenant_id=$1 AND installation_id=$2 AND is_active AND revoked_at IS NULL FOR SHARE`, input.TenantID, input.InstallationID.String()).Scan(&terminal)
				if e == nil {
					terminalID = &terminal
				} else if !errors.Is(e, pgx.ErrNoRows) {
					return e
				}
			}
		default:
			return domain.Validation("Konteks tidak valid", nil)
		}
		var id uuid.UUID
		if e := tx.QueryRow(ctx, `SELECT id FROM sessions WHERE id=$1 AND token_hash=$2 AND user_id=$3 AND (revoked_at IS NULL OR revoked_reason IN ('membership_changed','tenant_suspended','terminal_revoked')) FOR UPDATE`, current.SessionID, currentHash, current.UserID).Scan(&id); e != nil {
			return domain.NewError(domain.CodeUnauthorized, "Sesi telah berubah. Masuk kembali")
		}
		if _, e := tx.Exec(ctx, `UPDATE sessions SET revoked_at=now(),revoked_reason='context_switched' WHERE id=$1`, current.SessionID); e != nil {
			return e
		}
		if e := tx.QueryRow(ctx, `INSERT INTO sessions(user_id,token_hash,context_kind,tenant_id,membership_id,data_space_id,terminal_id,legacy_origin,protocol_version,sandbox_qris_policy)
		 SELECT $1,$2,$3,$4,$5,$6,$7,false,protocol_version,sandbox_qris_policy FROM sessions WHERE id=$8 RETURNING id`, current.UserID, replacementHash, input.Kind, tenantID, membershipID, spaceID, terminalID, current.SessionID).Scan(&id); e != nil {
			return e
		}
		var e error
		next, e = principalBySessionRow(ctx, tx, id, replacementHash)
		return e
	})
	return
}

func (s *Store) TenantMembers(ctx context.Context, actor domain.Principal) ([]domain.TenantMember, error) {
	defer observability.StartSegment(ctx, "Postgres.TenantMembers")()
	return nil, legacyUsersDisabled()
}

func (s *Store) UpdateTenantMember(ctx context.Context, actor domain.Principal, userID uuid.UUID, input domain.UpdateMembershipInput) (result domain.TenantMember, err error) {
	defer observability.StartSegment(ctx, "Postgres.UpdateTenantMember")()
	return result, legacyUsersDisabled()
}

func (s *Store) ListTenants(ctx context.Context, actor domain.Principal) ([]domain.Tenant, error) {
	defer observability.StartSegment(ctx, "Postgres.ListTenants")()
	if err := s.authorizeManagement(ctx, actor); err != nil {
		return nil, err
	}
	rows, err := s.Pool.Query(ctx, `SELECT id,name,slug,status,profile_revision,qris_revision,management_revision FROM tenants ORDER BY name,id`)
	if err != nil {
		return nil, dbError(err, "list tenants")
	}
	defer rows.Close()
	result := []domain.Tenant{}
	for rows.Next() {
		var t domain.Tenant
		if err = rows.Scan(&t.ID, &t.Name, &t.Slug, &t.Status, &t.ProfileRevision, &t.QrisRevision, &t.Revision); err != nil {
			return nil, err
		}
		result = append(result, t)
	}
	return result, rows.Err()
}

func (s *Store) CreateTenant(ctx context.Context, actor domain.Principal, input domain.CreateTenantInput, codeHash []byte) (result domain.CreateTenantResult, err error) {
	defer observability.StartSegment(ctx, "Postgres.CreateTenant")()
	err = s.controlTx(ctx, func(tx pgx.Tx) error {
		if e := lockManagedAccounts(ctx, tx, actor, uuid.Nil); e != nil {
			return e
		}
		var e error
		result.Tenant, e = scanTenant(tx.QueryRow(ctx, `INSERT INTO tenants(name,slug,status,created_by) VALUES($1,$2,'active',$3) RETURNING id,name,slug,status,profile_revision,qris_revision,management_revision`, input.Name, input.Slug, actor.UserID))
		if e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, `INSERT INTO tenant_profile_revisions(tenant_id,revision,business_name,address,phone,created_by) VALUES($1,1,$2,'','',$3)`, result.Tenant.ID, input.Name, actor.UserID); e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, `INSERT INTO data_spaces(tenant_id,mode,generation,status) VALUES($1,'production',1,'active')`, result.Tenant.ID); e != nil {
			return e
		}
		if e = seedOrganizationConfiguration(ctx, tx, result.Tenant.ID); e != nil {
			return e
		}
		return controlAudit(ctx, tx, &actor.UserID, &result.Tenant.ID, "tenant.created", map[string]any{"name": input.Name, "slug": input.Slug})
	})
	return
}

func (s *Store) SetTenantStatus(ctx context.Context, actor domain.Principal, id uuid.UUID, status string) (result domain.Tenant, err error) {
	defer observability.StartSegment(ctx, "Postgres.SetTenantStatus")()
	if status != "active" && status != "suspended" {
		return result, domain.Validation("Status bisnis tidak valid", nil)
	}
	err = s.controlTx(ctx, func(tx pgx.Tx) error {
		if e := lockControlAccount(ctx, tx, actor, true); e != nil {
			return e
		}
		var before string
		if e := tx.QueryRow(ctx, `SELECT status FROM tenants WHERE id=$1 FOR UPDATE`, id).Scan(&before); e != nil {
			return e
		}
		var e error
		result, e = scanTenant(tx.QueryRow(ctx, `UPDATE tenants SET status=$2,management_revision=management_revision+1,updated_at=now() WHERE id=$1 RETURNING id,name,slug,status,profile_revision,qris_revision,management_revision`, id, status))
		if e != nil {
			return e
		}
		if status == "suspended" {
			if _, e = tx.Exec(ctx, `UPDATE sessions SET revoked_at=now(),revoked_reason='tenant_suspended' WHERE tenant_id=$1 AND revoked_at IS NULL`, id); e != nil {
				return e
			}
		}
		if e = addTenantChange(ctx, tx, id, "tenant_metadata", id.String(), "updated", &result.Revision, result, false); e != nil {
			return e
		}
		return controlAudit(ctx, tx, &actor.UserID, &id, "tenant.status_changed", map[string]any{"before": before, "status": status})
	})
	return
}

func (s *Store) CreateTenantInvitation(ctx context.Context, actor domain.Principal, tenantID uuid.UUID, role domain.Role, owner bool, hash []byte) (result domain.Invitation, err error) {
	defer observability.StartSegment(ctx, "Postgres.CreateTenantInvitation")()
	return result, invitationsDisabled()
}

func invitationsDisabled() error {
	return domain.NewError("INVITATIONS_REMOVED", "Undangan tidak lagi digunakan. Semua akun aktif dapat memilih setiap bisnis. Hubungi Superadmin untuk membuat akun.")
}

func (s *Store) ListTenantInvitations(ctx context.Context, actor domain.Principal) ([]domain.Invitation, error) {
	defer observability.StartSegment(ctx, "Postgres.ListTenantInvitations")()
	return nil, invitationsDisabled()
}

func (s *Store) RevokeTenantInvitation(ctx context.Context, actor domain.Principal, id uuid.UUID) error {
	defer observability.StartSegment(ctx, "Postgres.RevokeTenantInvitation")()
	return invitationsDisabled()
}

func (s *Store) AcceptTenantInvitation(ctx context.Context, actor domain.Principal, hash []byte) (result domain.TenantContext, err error) {
	defer observability.StartSegment(ctx, "Postgres.AcceptTenantInvitation")()
	return result, invitationsDisabled()
}

func (s *Store) RegisterTenantInvitation(ctx context.Context, input domain.RegisterInvitationInput, passwordHash string, codeHash []byte) (userID uuid.UUID, err error) {
	defer observability.StartSegment(ctx, "Postgres.RegisterTenantInvitation")()
	return uuid.Nil, invitationsDisabled()
}

func (s *Store) GetTenantProfile(ctx context.Context, tenantID uuid.UUID) (p domain.TenantProfile, err error) {
	defer observability.StartSegment(ctx, "Postgres.GetTenantProfile")()
	err = s.Pool.QueryRow(ctx, `SELECT p.tenant_id,p.revision,p.business_name,p.address,p.phone FROM tenant_profile_revisions p JOIN tenants t ON t.id=p.tenant_id AND t.profile_revision=p.revision WHERE p.tenant_id=$1`, tenantID).Scan(&p.TenantID, &p.Revision, &p.BusinessName, &p.Address, &p.Phone)
	return p, dbError(err, "read tenant profile")
}

func (s *Store) UpdateTenantProfile(ctx context.Context, actor domain.Principal, input domain.UpdateTenantProfileInput) (result domain.TenantProfile, err error) {
	defer observability.StartSegment(ctx, "Postgres.UpdateTenantProfile")()
	err = s.controlTx(ctx, func(tx pgx.Tx) error {
		if e := lockTenantOwner(ctx, tx, actor); e != nil {
			return e
		}
		var revision int
		if e := tx.QueryRow(ctx, `SELECT profile_revision FROM tenants WHERE id=$1 FOR UPDATE`, actor.TenantID).Scan(&revision); e != nil {
			return e
		}
		if revision != input.ExpectedRevision {
			return domain.NewError(domain.CodeRevisionConflict, "Profil bisnis telah berubah. Muat ulang sebelum menyimpan")
		}
		result = domain.TenantProfile{TenantID: actor.TenantID, Revision: revision + 1, BusinessName: input.BusinessName, Address: input.Address, Phone: input.Phone}
		if _, e := tx.Exec(ctx, `INSERT INTO tenant_profile_revisions(tenant_id,revision,business_name,address,phone,created_by) VALUES($1,$2,$3,$4,$5,$6)`, result.TenantID, result.Revision, result.BusinessName, result.Address, result.Phone, actor.UserID); e != nil {
			return e
		}
		if _, e := tx.Exec(ctx, `UPDATE tenants SET profile_revision=$2,updated_at=now() WHERE id=$1`, actor.TenantID, result.Revision); e != nil {
			return e
		}
		if e := controlAudit(ctx, tx, &actor.UserID, &actor.TenantID, "tenant.profile_updated", map[string]any{"revision": result.Revision}); e != nil {
			return e
		}
		return addTenantChange(ctx, tx, actor.TenantID, "tenant_profile", actor.TenantID.String(), "updated", &result.Revision, result, false)
	})
	return
}

func tenantQRISConfig(ctx context.Context, query interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}, tenantID uuid.UUID) (result domain.TenantQRISConfig, err error) {
	defer observability.StartSegment(ctx, "Postgres.tenantQRISConfig")()
	result.Payloads = []domain.TenantQRIS{}
	rows, err := query.Query(ctx, `SELECT r.tenant_id,r.revision,r.payload_hash,r.static_payload,t.qris_revision=r.revision FROM tenant_qris_revisions r JOIN tenants t ON t.id=r.tenant_id WHERE r.tenant_id=$1 ORDER BY r.revision`, tenantID)
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		var p domain.TenantQRIS
		var active *bool
		if err = rows.Scan(&p.TenantID, &p.Revision, &p.PayloadHash, &p.StaticPayload, &active); err != nil {
			return result, err
		}
		result.Payloads = append(result.Payloads, p)
		result.Revision = p.Revision
		if active != nil && *active {
			hash := p.PayloadHash
			result.ActivePayloadHash = &hash
		}
	}
	return result, rows.Err()
}

func (s *Store) GetTenantQRIS(ctx context.Context, tenantID uuid.UUID) (domain.TenantQRISConfig, error) {
	defer observability.StartSegment(ctx, "Postgres.GetTenantQRIS")()
	result, err := tenantQRISConfig(ctx, s.Pool, tenantID)
	return result, dbError(err, "read tenant QRIS")
}

func (s *Store) UpdateTenantQRIS(ctx context.Context, actor domain.Principal, input domain.UpdateTenantQRISInput, hash string) (result domain.TenantQRISConfig, err error) {
	defer observability.StartSegment(ctx, "Postgres.UpdateTenantQRIS")()
	err = s.controlTx(ctx, func(tx pgx.Tx) error {
		if e := lockTenantOwner(ctx, tx, actor); e != nil {
			return e
		}
		var id uuid.UUID
		if e := tx.QueryRow(ctx, `SELECT id FROM tenants WHERE id=$1 FOR UPDATE`, actor.TenantID).Scan(&id); e != nil {
			return e
		}
		current, e := tenantQRISConfig(ctx, tx, actor.TenantID)
		if e != nil {
			return e
		}
		if current.Revision != input.ExpectedRevision {
			return domain.NewError(domain.CodeRevisionConflict, "QRIS bisnis telah berubah. Muat ulang sebelum menyimpan")
		}
		revision := current.Revision + 1
		// Every setting update advances the optimistic revision, including a
		// reactivation of an already imported payload. Historical bytes stay intact.
		if _, e = tx.Exec(ctx, `INSERT INTO tenant_qris_revisions(tenant_id,revision,payload_hash,static_payload,created_by) VALUES($1,$2,$3,$4,$5)`, actor.TenantID, revision, hash, input.StaticPayload, actor.UserID); e != nil {
			return e
		}
		if input.Activate == nil || *input.Activate {
			if _, e = tx.Exec(ctx, `UPDATE tenants SET qris_revision=$2,updated_at=now() WHERE id=$1`, actor.TenantID, revision); e != nil {
				return e
			}
		}
		if e = controlAudit(ctx, tx, &actor.UserID, &actor.TenantID, "tenant.qris_updated", map[string]any{"revision": revision, "payloadHash": hash, "activated": input.Activate == nil || *input.Activate}); e != nil {
			return e
		}
		result, e = tenantQRISConfig(ctx, tx, actor.TenantID)
		if e != nil {
			return e
		}
		return addTenantChange(ctx, tx, actor.TenantID, "tenant_qris", actor.TenantID.String(), "updated", &result.Revision, result, false)
	})
	return
}
