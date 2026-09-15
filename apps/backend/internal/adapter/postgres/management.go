package postgres

import (
	"context"
	"sort"

	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/domain"
	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/observability"
	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/port"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

var _ port.ManagementRepository = (*Store)(nil)

// Attribution links keep historical composite foreign keys intact. They no
// longer grant access or determine roles, and existing links are never replaced.
func ensureAccountTenantLink(ctx context.Context, tx pgx.Tx, tenantID, userID uuid.UUID) (uuid.UUID, error) {
	defer observability.StartSegment(ctx, "Postgres.ensureAccountTenantLink")()
	_, err := tx.Exec(ctx, `INSERT INTO tenant_memberships(tenant_id,user_id,role,status)
	 SELECT $1,id,role,'active' FROM users WHERE id=$2 AND is_active AND deleted_at IS NULL
	 ON CONFLICT(tenant_id,user_id) DO NOTHING`, tenantID, userID)
	if err != nil {
		return uuid.Nil, err
	}
	var id uuid.UUID
	err = tx.QueryRow(ctx, `SELECT id FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2`, tenantID, userID).Scan(&id)
	return id, err
}

func (s *Store) authorizeManagement(ctx context.Context, actor domain.Principal) error {
	defer observability.StartSegment(ctx, "Postgres.authorizeManagement")()
	if actor.ContextKind != domain.ContextAccount && actor.ContextKind != domain.ContextTenant {
		return domain.NewError(domain.CodeForbidden, "Otorisasi akun Superadmin diperlukan")
	}
	var allowed bool
	err := s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM users u JOIN sessions s ON s.user_id=u.id
	 WHERE u.id=$1 AND s.id=$2 AND s.context_kind=$3 AND s.revoked_at IS NULL
	 AND u.role='superadmin' AND u.is_active AND u.deleted_at IS NULL AND NOT u.must_change_password)`, actor.UserID, actor.SessionID, actor.ContextKind).Scan(&allowed)
	if err != nil {
		return dbError(err, "authorize organization management")
	}
	if !allowed {
		return domain.NewError(domain.CodeForbidden, "Otorisasi akun Superadmin diperlukan")
	}
	return nil
}

func lockManagedAccounts(ctx context.Context, tx pgx.Tx, actor domain.Principal, target uuid.UUID) error {
	defer observability.StartSegment(ctx, "Postgres.lockManagedAccounts")()
	// Serialize the last-Superadmin decision before acquiring account locks.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('organization-account-administration',0))`); err != nil {
		return err
	}
	ids := []uuid.UUID{actor.UserID}
	if target != uuid.Nil && target != actor.UserID {
		ids = append(ids, target)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i].String() < ids[j].String() })
	for _, id := range ids {
		var found uuid.UUID
		if err := tx.QueryRow(ctx, `SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, id).Scan(&found); err != nil {
			return err
		}
	}
	return lockControlAccount(ctx, tx, actor, true)
}

func (s *Store) ListManagedUsers(ctx context.Context, actor domain.Principal) ([]domain.User, error) {
	defer observability.StartSegment(ctx, "Postgres.ListManagedUsers")()
	if err := s.authorizeManagement(ctx, actor); err != nil {
		return nil, err
	}
	rows, err := s.Pool.Query(ctx, `SELECT id,full_name,username,role,is_active,must_change_password,created_at,updated_at,deleted_at FROM users WHERE deleted_at IS NULL ORDER BY full_name,id`)
	if err != nil {
		return nil, dbError(err, "list organization users")
	}
	defer rows.Close()
	result := []domain.User{}
	for rows.Next() {
		u, err := scanAccountUser(rows)
		if err != nil {
			return nil, dbError(err, "scan organization user")
		}
		result = append(result, u)
	}
	return result, dbError(rows.Err(), "read organization users")
}

func (s *Store) GetManagedUser(ctx context.Context, actor domain.Principal, id uuid.UUID) (domain.User, error) {
	defer observability.StartSegment(ctx, "Postgres.GetManagedUser")()
	if err := s.authorizeManagement(ctx, actor); err != nil {
		return domain.User{}, err
	}
	u, err := scanAccountUser(s.Pool.QueryRow(ctx, `SELECT id,full_name,username,role,is_active,must_change_password,created_at,updated_at,deleted_at FROM users WHERE id=$1 AND deleted_at IS NULL`, id))
	return u, dbError(err, "read organization user")
}

func (s *Store) CreateManagedUser(ctx context.Context, actor domain.Principal, input domain.CreateUserInput, hash string) (result domain.User, err error) {
	defer observability.StartSegment(ctx, "Postgres.CreateManagedUser")()
	err = s.controlTx(ctx, func(tx pgx.Tx) error {
		if e := lockManagedAccounts(ctx, tx, actor, uuid.Nil); e != nil {
			return e
		}
		var e error
		result, e = scanAccountUser(tx.QueryRow(ctx, `INSERT INTO users(full_name,username,role,password_hash,must_change_password)
		 VALUES($1,$2,$3,$4,true) RETURNING id,full_name,username,role,is_active,must_change_password,created_at,updated_at,deleted_at`, input.FullName, input.Username, input.Role, hash))
		if e != nil {
			return e
		}
		if e = controlAudit(ctx, tx, &actor.UserID, nil, "account.created", map[string]any{"accountId": result.ID, "role": result.Role}); e != nil {
			return e
		}
		return addSharedChange(ctx, tx, "user", result.ID.String(), "created", nil, result, false)
	})
	return
}

func (s *Store) UpdateManagedUser(ctx context.Context, actor domain.Principal, id uuid.UUID, input domain.UpdateManagedUserInput) (result domain.User, err error) {
	defer observability.StartSegment(ctx, "Postgres.UpdateManagedUser")()
	err = s.controlTx(ctx, func(tx pgx.Tx) error {
		if e := lockManagedAccounts(ctx, tx, actor, id); e != nil {
			return e
		}
		before, e := scanAccountUser(tx.QueryRow(ctx, `SELECT id,full_name,username,role,is_active,must_change_password,created_at,updated_at,deleted_at FROM users WHERE id=$1`, id))
		if e != nil {
			return e
		}
		role, active := before.Role, before.IsActive
		if input.Role != nil {
			role = *input.Role
		}
		if input.Active != nil {
			active = *input.Active
		}
		if !role.Valid() {
			return domain.Validation("Peran pengguna tidak valid", nil)
		}
		if actor.UserID == id && (role != domain.RoleSuperadmin || !active) {
			return domain.NewError(domain.CodeSelfMutation, "Anda tidak dapat menurunkan peran atau menonaktifkan akun sendiri")
		}
		if before.Role == domain.RoleSuperadmin && before.IsActive && (role != domain.RoleSuperadmin || !active) {
			var count int
			if e = tx.QueryRow(ctx, `SELECT count(*) FROM users WHERE id<>$1 AND role='superadmin' AND is_active AND deleted_at IS NULL`, id).Scan(&count); e != nil {
				return e
			}
			if count == 0 {
				return domain.NewError(domain.CodeFinalSuperadmin, "Setidaknya satu Superadmin aktif harus tetap tersedia")
			}
		}
		result, e = scanAccountUser(tx.QueryRow(ctx, `UPDATE users SET role=$2,is_active=$3,updated_at=now() WHERE id=$1 RETURNING id,full_name,username,role,is_active,must_change_password,created_at,updated_at,deleted_at`, id, role, active))
		if e != nil {
			return e
		}
		if role != before.Role || active != before.IsActive {
			if _, e = tx.Exec(ctx, `UPDATE sessions SET revoked_at=now(),revoked_reason='account_access_changed' WHERE user_id=$1 AND revoked_at IS NULL`, id); e != nil {
				return e
			}
		}
		if e = controlAudit(ctx, tx, &actor.UserID, nil, "account.access_changed", map[string]any{"accountId": id, "beforeRole": before.Role, "role": role, "beforeActive": before.IsActive, "active": active}); e != nil {
			return e
		}
		return addSharedChange(ctx, tx, "user", id.String(), "updated", nil, result, false)
	})
	return
}

func (s *Store) ResetManagedPassword(ctx context.Context, actor domain.Principal, id uuid.UUID, hash string) (result domain.User, err error) {
	defer observability.StartSegment(ctx, "Postgres.ResetManagedPassword")()
	err = s.controlTx(ctx, func(tx pgx.Tx) error {
		if e := lockManagedAccounts(ctx, tx, actor, id); e != nil {
			return e
		}
		var e error
		result, e = scanAccountUser(tx.QueryRow(ctx, `UPDATE users SET password_hash=$2,must_change_password=true,updated_at=now() WHERE id=$1 RETURNING id,full_name,username,role,is_active,must_change_password,created_at,updated_at,deleted_at`, id, hash))
		if e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, `UPDATE sessions SET revoked_at=now(),revoked_reason='password_recovered' WHERE user_id=$1 AND revoked_at IS NULL`, id); e != nil {
			return e
		}
		if e = controlAudit(ctx, tx, &actor.UserID, nil, "account.password_recovered", map[string]any{"accountId": id, "mustChangePassword": true}); e != nil {
			return e
		}
		return addSharedChange(ctx, tx, "user", id.String(), "updated", nil, result, false)
	})
	return
}

func (s *Store) UpdateManagedTenant(ctx context.Context, actor domain.Principal, id uuid.UUID, input domain.UpdateTenantInput) (result domain.Tenant, err error) {
	defer observability.StartSegment(ctx, "Postgres.UpdateManagedTenant")()
	err = s.controlTx(ctx, func(tx pgx.Tx) error {
		if e := lockControlAccount(ctx, tx, actor, true); e != nil {
			return e
		}
		before, e := scanTenant(tx.QueryRow(ctx, `SELECT id,name,slug,status,profile_revision,qris_revision,management_revision FROM tenants WHERE id=$1 FOR UPDATE`, id))
		if e != nil {
			return e
		}
		if before.Revision != input.ExpectedRevision {
			return domain.NewError(domain.CodeRevisionConflict, "Data bisnis telah berubah. Muat ulang sebelum menyimpan")
		}
		result, e = scanTenant(tx.QueryRow(ctx, `UPDATE tenants SET name=$2,management_revision=management_revision+1,updated_at=now() WHERE id=$1 RETURNING id,name,slug,status,profile_revision,qris_revision,management_revision`, id, input.Name))
		if e != nil {
			return e
		}
		if e = controlAudit(ctx, tx, &actor.UserID, &id, "tenant.name_changed", map[string]any{"before": before.Name, "name": result.Name, "revision": result.Revision}); e != nil {
			return e
		}
		return addTenantChange(ctx, tx, id, "tenant_metadata", id.String(), "updated", &result.Revision, result, false)
	})
	return
}

func seedOrganizationConfiguration(ctx context.Context, tx pgx.Tx, tenantID uuid.UUID) error {
	defer observability.StartSegment(ctx, "Postgres.seedOrganizationConfiguration")()
	tenant, err := scanTenant(tx.QueryRow(ctx, `SELECT id,name,slug,status,profile_revision,qris_revision,management_revision FROM tenants WHERE id=$1`, tenantID))
	if err != nil {
		return err
	}
	if err = addTenantChange(ctx, tx, tenantID, "tenant_metadata", tenantID.String(), "created", &tenant.Revision, tenant, false); err != nil {
		return err
	}
	profile := domain.TenantProfile{TenantID: tenantID, Revision: 1, BusinessName: tenant.Name}
	if err = addTenantChange(ctx, tx, tenantID, "tenant_profile", tenantID.String(), "created", &profile.Revision, profile, false); err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `SELECT id FROM users WHERE is_active AND deleted_at IS NULL ORDER BY id`)
	if err != nil {
		return err
	}
	var ids []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, id := range ids {
		if err = addTenantChange(ctx, tx, tenantID, "user", id.String(), "created", nil, nil, false); err != nil {
			return err
		}
	}
	return nil
}
