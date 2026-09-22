package usecase

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/domain"
	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/observability"
	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/port"
	"github.com/google/uuid"
)

type Auth struct {
	Repo           port.Repository
	Passwords      port.PasswordHasher
	Tokens         port.TokenManager
	Sessions       port.SessionIndex
	Limiter        port.RateLimiter
	RateLimit      int
	RateWindow     time.Duration
	SandboxEnabled bool
}

type Authentication struct {
	Principal                 domain.Principal
	TokenHash                 []byte
	RecoverableRetiredSandbox bool
	RecoverableTenantAccess   bool
}

func (a Auth) Login(ctx context.Context, input domain.LoginInput) (domain.LoginResult, error) {
	defer observability.StartSegment(ctx, "Usecase.Auth.Login")()
	input.Username = domain.NormalizeUsername(input.Username)
	if input.Username == "" || input.Password == "" {
		return domain.LoginResult{}, domain.Validation("Username dan kata sandi wajib diisi", nil)
	}
	key := input.IPAddress + ":" + input.Username
	if allowed, err := a.Limiter.Allow(ctx, key, a.RateLimit, a.RateWindow); err == nil && !allowed {
		return domain.LoginResult{}, domain.NewError(domain.CodeRateLimited, "Terlalu banyak percobaan masuk. Coba lagi nanti.")
	}

	user, err := a.Repo.UserForLogin(ctx, input.Username)
	if err != nil {
		if domain.IsCode(err, domain.CodeNotFound) {
			return domain.LoginResult{}, domain.NewError(domain.CodeInvalidCredentials, "Username atau kata sandi salah")
		}
		return domain.LoginResult{}, err
	}
	ok, verifyErr := a.Passwords.Verify(input.Password, user.PasswordHash)
	if verifyErr != nil || !ok || !user.IsActive || user.DeletedAt != nil {
		return domain.LoginResult{}, domain.NewError(domain.CodeInvalidCredentials, "Username atau kata sandi salah")
	}

	raw, tokenHash, err := a.Tokens.New()
	if err != nil {
		return domain.LoginResult{}, domain.WrapInternal(err, "issue session token")
	}
	repo, ok := a.Repo.(port.VerifiedLoginSessionRepository)
	if !ok {
		return domain.LoginResult{}, domain.WrapInternal(fmt.Errorf("repository does not support credential-bound login sessions"), "issue session")
	}
	session := port.VerifiedLoginSession{
		UserID: user.ID, VerifiedPasswordHash: user.PasswordHash, TokenHash: tokenHash,
		ProtocolVersion: domain.NegotiatedClientProtocolVersion(input.ClientProtocolVersion),
	}
	if input.ClientProtocolVersion < 2 {
		if input.InstallationID != nil {
			session.TerminalID, err = a.Repo.TerminalIDByInstallation(ctx, domain.InitialTenantID(), *input.InstallationID)
			if err != nil {
				return domain.LoginResult{}, err
			}
		}
		production, err := a.Repo.ActiveDataSpace(ctx, domain.InitialTenantID(), domain.DataModeProduction)
		if err != nil {
			return domain.LoginResult{}, err
		}
		session.DataSpaceID = production.ID
	}
	principal, err := repo.CreateVerifiedLoginSession(ctx, session)
	if err != nil {
		return domain.LoginResult{}, err
	}
	a.Sessions.Set(ctx, tokenHash, principal.SessionID)
	return domain.LoginResult{Token: raw, Principal: principal}, nil
}

// UpgradeSession exchanges a token, never mutates its historical scope or policy.
func (a Auth) UpgradeSession(ctx context.Context, authentication Authentication, protocol int) (domain.LoginResult, error) {
	defer observability.StartSegment(ctx, "Usecase.Auth.UpgradeSession")()
	if protocol != domain.CurrentClientProtocolVersion {
		return domain.LoginResult{}, domain.Validation("Versi protokol pembaruan sesi tidak didukung", map[string]any{"field": "protocolVersion"})
	}
	if authentication.RecoverableRetiredSandbox || authentication.RecoverableTenantAccess {
		return domain.LoginResult{}, domain.NewError(domain.CodeUnauthorized, "Pulihkan akses bisnis terlebih dahulu sebelum memperbarui sesi")
	}
	repo, ok := a.Repo.(port.SessionPolicyRepository)
	if !ok {
		return domain.LoginResult{}, domain.NewError(domain.CodeClientUpdateRequired, "Server belum mendukung sesi terbaru. Hubungi pengelola untuk memperbarui backend")
	}
	raw, hash, err := a.Tokens.New()
	if err != nil {
		return domain.LoginResult{}, domain.WrapInternal(err, "issue upgraded session token")
	}
	principal, err := repo.UpgradeSession(ctx, authentication.Principal, authentication.TokenHash, hash, protocol)
	if err != nil {
		return domain.LoginResult{}, err
	}
	a.Sessions.Delete(ctx, authentication.TokenHash)
	a.Sessions.Set(ctx, hash, principal.SessionID)
	return domain.LoginResult{Token: raw, Principal: principal}, nil
}

func (a Auth) Authenticate(ctx context.Context, rawToken string) (Authentication, error) {
	defer observability.StartSegment(ctx, "Usecase.Auth.Authenticate")()
	tokenHash, err := a.Tokens.Hash(strings.TrimSpace(rawToken))
	if err != nil {
		return Authentication{}, domain.NewError(domain.CodeUnauthorized, "Sesi tidak valid")
	}
	if sessionID, ok := a.Sessions.Get(ctx, tokenHash); ok {
		principal, repoErr := a.Repo.PrincipalBySession(ctx, sessionID, tokenHash)
		if repoErr == nil {
			return Authentication{Principal: principal, TokenHash: tokenHash}, nil
		}
		if tenantAccessError(repoErr) && principal.SessionID != uuid.Nil {
			return Authentication{Principal: principal, TokenHash: tokenHash, RecoverableTenantAccess: true}, repoErr
		}
		if domain.IsCode(repoErr, domain.CodeSandboxGenerationRetired) &&
			principal.SessionID != uuid.Nil {
			a.Sessions.Delete(ctx, tokenHash)
			return Authentication{
				Principal: principal, TokenHash: tokenHash,
				RecoverableRetiredSandbox: true,
			}, repoErr
		}
		// Only a confirmed missing mapping is a stale cache entry. Connection
		// failures must remain retryable and must not evict a valid token index.
		if !domain.IsCode(repoErr, domain.CodeNotFound) {
			if domain.IsCode(repoErr, domain.CodeUnauthorized) {
				a.Sessions.Delete(ctx, tokenHash)
			}
			return Authentication{}, repoErr
		}
		a.Sessions.Delete(ctx, tokenHash)
	}
	principal, err := a.Repo.PrincipalByTokenHash(ctx, tokenHash)
	if err != nil {
		if tenantAccessError(err) && principal.SessionID != uuid.Nil {
			return Authentication{Principal: principal, TokenHash: tokenHash, RecoverableTenantAccess: true}, err
		}
		if domain.IsCode(err, domain.CodeSandboxGenerationRetired) &&
			principal.SessionID != uuid.Nil {
			return Authentication{
				Principal: principal, TokenHash: tokenHash,
				RecoverableRetiredSandbox: true,
			}, err
		}
		if domain.IsCode(err, domain.CodeNotFound) || domain.IsCode(err, domain.CodeUnauthorized) {
			return Authentication{}, domain.NewError(domain.CodeUnauthorized, "Sesi tidak valid atau telah dicabut")
		}
		return Authentication{}, err
	}
	a.Sessions.Set(ctx, tokenHash, principal.SessionID)
	return Authentication{Principal: principal, TokenHash: tokenHash}, nil
}

func (a Auth) SwitchMode(ctx context.Context, authentication Authentication, mode domain.DataMode) (domain.LoginResult, error) {
	defer observability.StartSegment(ctx, "Usecase.Auth.SwitchMode")()
	principal := authentication.Principal
	if err := RequireTenant(principal); err != nil {
		return domain.LoginResult{}, err
	}
	if !mode.Valid() {
		return domain.LoginResult{}, domain.Validation("Mode operasi harus production atau sandbox", map[string]any{"field": "mode"})
	}
	if mode == domain.DataModeSandbox && !a.sandboxEnabled(principal) {
		return domain.LoginResult{}, domain.NewError(domain.CodeSandboxDisabled, "Mode Uji telah dinonaktifkan untuk bisnis ini")
	}
	if mode == principal.EffectiveDataMode() && !authentication.RecoverableRetiredSandbox {
		return domain.LoginResult{}, domain.NewError(domain.CodeConflict, "Sesi sudah menggunakan mode yang dipilih")
	}
	space, err := a.Repo.ActiveDataSpace(ctx, principal.TenantID, mode)
	if mode == domain.DataModeSandbox && domain.IsCode(err, domain.CodeNotFound) {
		space, err = a.Repo.EnsureSandbox(ctx, principal.TenantID)
	}
	if err != nil {
		return domain.LoginResult{}, err
	}
	raw, tokenHash, err := a.Tokens.New()
	if err != nil {
		return domain.LoginResult{}, domain.WrapInternal(err, "issue switched session token")
	}
	var switched domain.Principal
	if authentication.RecoverableRetiredSandbox {
		if principal.EffectiveDataMode() != domain.DataModeSandbox {
			return domain.LoginResult{}, domain.NewError(domain.CodeUnauthorized, "Sesi tidak valid atau telah dicabut")
		}
		switched, err = a.Repo.RecoverRetiredSandboxSession(
			ctx,
			principal,
			authentication.TokenHash,
			tokenHash,
			space.ID,
		)
	} else {
		switched, err = a.Repo.SwitchSession(
			ctx,
			principal,
			authentication.TokenHash,
			tokenHash,
			space.ID,
		)
	}
	if err != nil {
		return domain.LoginResult{}, err
	}
	a.Sessions.Delete(ctx, authentication.TokenHash)
	a.Sessions.Set(ctx, tokenHash, switched.SessionID)
	return domain.LoginResult{Token: raw, Principal: switched}, nil
}

func (a Auth) sandboxEnabled(principal domain.Principal) bool {
	if principal.SandboxEnabledOverride != nil {
		return *principal.SandboxEnabledOverride
	}
	return a.SandboxEnabled
}

func (a Auth) Logout(ctx context.Context, principal domain.Principal) error {
	defer observability.StartSegment(ctx, "Usecase.Auth.Logout")()
	return a.Repo.RevokeSession(ctx, principal.SessionID, principal.UserID, "logout")
}

func (a Auth) ChangePassword(ctx context.Context, principal domain.Principal, current, next string) error {
	defer observability.StartSegment(ctx, "Usecase.Auth.ChangePassword")()
	if principal.ContextKind == domain.ContextTenant && principal.DataMode == domain.DataModeSandbox {
		return domain.NewError(domain.CodeForbidden, "Ganti kata sandi melalui akun atau mode produksi")
	}
	if err := domain.ValidatePassword(next); err != nil {
		return err
	}
	if current == next {
		return domain.Validation("Kata sandi baru harus berbeda", map[string]any{"field": "newPassword"})
	}
	user, err := a.Repo.UserForLogin(ctx, principal.Username)
	if err != nil {
		return domain.NewError(domain.CodeUnauthorized, "Pengguna tidak ditemukan")
	}
	ok, err := a.Passwords.Verify(current, user.PasswordHash)
	if err != nil || !ok {
		return domain.Validation("Kata sandi saat ini salah", map[string]any{"field": "currentPassword"})
	}
	hash, err := a.Passwords.Hash(next)
	if err != nil {
		return domain.WrapInternal(err, "hash changed password")
	}
	if err := a.Repo.ChangeOwnPassword(ctx, principal, hash); err != nil {
		return err
	}
	return nil
}

func RequireReady(principal domain.Principal) error {
	if principal.MustChangePassword {
		return domain.NewError(domain.CodePasswordChange, "Ganti kata sandi sementara sebelum melanjutkan")
	}
	return nil
}

func RequireSuperadmin(principal domain.Principal) error {
	if err := RequireTenant(principal); err != nil {
		return err
	}
	if !principal.IsSuperadmin() {
		return domain.NewError(domain.CodeForbidden, "Tindakan ini hanya tersedia untuk superadmin")
	}
	return nil
}

func RequireProduction(principal domain.Principal) error {
	if err := RequireTenant(principal); err != nil {
		return err
	}
	if principal.EffectiveDataMode() != domain.DataModeProduction {
		return domain.NewError(domain.CodeForbidden, "Tindakan ini hanya tersedia di mode produksi")
	}
	return nil
}

func RequireTerminal(principal domain.Principal) error {
	if err := RequireTenant(principal); err != nil {
		return err
	}
	if principal.TerminalID == nil {
		return domain.NewError(domain.CodeForbidden, "Daftarkan terminal ini sebelum membuat perubahan lokal")
	}
	return nil
}

func RequireTenant(principal domain.Principal) error {
	if err := RequireReady(principal); err != nil {
		return err
	}
	if !principal.IsTenantContext() || principal.MembershipID == uuid.Nil {
		return domain.NewError(domain.CodeContextRequired, "Pilih bisnis yang aktif sebelum melanjutkan")
	}
	return nil
}

func tenantAccessError(err error) bool {
	return domain.IsCode(err, domain.CodeAccountAccessChanged) || domain.IsCode(err, domain.CodeTenantSuspended) || domain.IsCode(err, domain.CodeMembershipInactive) || domain.IsCode(err, domain.CodeMembershipRevoked)
}

func (a Auth) SwitchContext(ctx context.Context, authentication Authentication, input domain.SwitchContextInput) (domain.LoginResult, error) {
	defer observability.StartSegment(ctx, "Usecase.Auth.SwitchContext")()
	if err := RequireReady(authentication.Principal); err != nil {
		return domain.LoginResult{}, err
	}
	repo, ok := a.Repo.(port.TenancyRepository)
	if !ok {
		return domain.LoginResult{}, domain.NewError(domain.CodeInternal, "Konteks belum tersedia")
	}
	raw, hash, err := a.Tokens.New()
	if err != nil {
		return domain.LoginResult{}, domain.WrapInternal(err, "issue context token")
	}
	principal, err := repo.SwitchContextSession(ctx, authentication.Principal, authentication.TokenHash, hash, input)
	if err != nil {
		return domain.LoginResult{}, err
	}
	a.Sessions.Delete(ctx, authentication.TokenHash)
	a.Sessions.Set(ctx, hash, principal.SessionID)
	return domain.LoginResult{Token: raw, Principal: principal}, nil
}

func BearerToken(header string) (string, error) {
	scheme, value, ok := strings.Cut(strings.TrimSpace(header), " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") || strings.TrimSpace(value) == "" {
		return "", fmt.Errorf("missing bearer token")
	}
	return strings.TrimSpace(value), nil
}
