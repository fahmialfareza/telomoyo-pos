package usecase

import (
	"context"
	"regexp"
	"strings"

	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/domain"
	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/observability"
	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/port"
	"github.com/google/uuid"
)

type Management struct {
	Repo      port.ManagementRepository
	Passwords port.PasswordHasher
}

func RequireManagement(p domain.Principal) error {
	if err := RequireReady(p); err != nil {
		return err
	}
	if (p.ContextKind != domain.ContextAccount && p.ContextKind != domain.ContextTenant) || !p.IsSuperadmin() {
		return domain.NewError(domain.CodeForbidden, "Pengelolaan organisasi hanya tersedia pada akun Superadmin")
	}
	return nil
}

func (m Management) ListUsers(ctx context.Context, p domain.Principal) ([]domain.User, error) {
	defer observability.StartSegment(ctx, "Usecase.Management.ListUsers")()
	if err := RequireManagement(p); err != nil {
		return nil, err
	}
	return m.Repo.ListManagedUsers(ctx, p)
}

func (m Management) GetUser(ctx context.Context, p domain.Principal, id uuid.UUID) (domain.User, error) {
	defer observability.StartSegment(ctx, "Usecase.Management.GetUser")()
	if err := RequireManagement(p); err != nil {
		return domain.User{}, err
	}
	return m.Repo.GetManagedUser(ctx, p, id)
}

func (m Management) CreateUser(ctx context.Context, p domain.Principal, input domain.CreateUserInput) (domain.User, error) {
	defer observability.StartSegment(ctx, "Usecase.Management.CreateUser")()
	if err := RequireManagement(p); err != nil {
		return domain.User{}, err
	}
	input.FullName = strings.TrimSpace(input.FullName)
	input.Username = domain.NormalizeUsername(input.Username)
	if input.FullName == "" || len(input.FullName) > 160 || !regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{2,63}$`).MatchString(input.Username) || !input.Role.Valid() {
		return domain.User{}, domain.Validation("Nama, username, dan peran pengguna tidak valid", nil)
	}
	if err := domain.ValidatePassword(input.TemporaryPassword); err != nil {
		return domain.User{}, err
	}
	hash, err := m.Passwords.Hash(input.TemporaryPassword)
	if err != nil {
		return domain.User{}, domain.WrapInternal(err, "hash managed temporary password")
	}
	return m.Repo.CreateManagedUser(ctx, p, input, hash)
}

func (m Management) UpdateUser(ctx context.Context, p domain.Principal, id uuid.UUID, input domain.UpdateManagedUserInput) (domain.User, error) {
	defer observability.StartSegment(ctx, "Usecase.Management.UpdateUser")()
	if err := RequireManagement(p); err != nil {
		return domain.User{}, err
	}
	if input.Role == nil && input.Active == nil {
		return domain.User{}, domain.Validation("Pilih peran atau status yang akan diubah", nil)
	}
	if input.Role != nil && !input.Role.Valid() {
		return domain.User{}, domain.Validation("Peran pengguna tidak valid", nil)
	}
	return m.Repo.UpdateManagedUser(ctx, p, id, input)
}

func (m Management) ResetPassword(ctx context.Context, p domain.Principal, id uuid.UUID, password string) (domain.User, error) {
	defer observability.StartSegment(ctx, "Usecase.Management.ResetPassword")()
	if err := RequireManagement(p); err != nil {
		return domain.User{}, err
	}
	if err := domain.ValidatePassword(password); err != nil {
		return domain.User{}, err
	}
	hash, err := m.Passwords.Hash(password)
	if err != nil {
		return domain.User{}, domain.WrapInternal(err, "hash managed reset password")
	}
	return m.Repo.ResetManagedPassword(ctx, p, id, hash)
}

func (m Management) UpdateTenant(ctx context.Context, p domain.Principal, id uuid.UUID, input domain.UpdateTenantInput) (domain.Tenant, error) {
	defer observability.StartSegment(ctx, "Usecase.Management.UpdateTenant")()
	if err := RequireManagement(p); err != nil {
		return domain.Tenant{}, err
	}
	input.Name = strings.TrimSpace(input.Name)
	if input.Name == "" || len(input.Name) > 160 || input.ExpectedRevision < 1 {
		return domain.Tenant{}, domain.Validation("Nama dan revisi bisnis tidak valid", nil)
	}
	return m.Repo.UpdateManagedTenant(ctx, p, id, input)
}
