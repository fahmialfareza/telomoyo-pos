package usecase

import (
	"context"
	"testing"
	"time"

	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/domain"
	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/port"
	"github.com/google/uuid"
)

type verifiedLoginRepository struct {
	port.Repository
	user      domain.UserAuth
	input     port.VerifiedLoginSession
	principal domain.Principal
	err       error
	userErr   error
	called    bool
}

func (r *verifiedLoginRepository) UserForLogin(context.Context, string) (domain.UserAuth, error) {
	return r.user, r.userErr
}

func TestLoginPreservesDatabaseLookupFailure(t *testing.T) {
	repo := &verifiedLoginRepository{
		userErr: domain.WrapInternal(context.DeadlineExceeded, "find login user"),
	}
	auth := Auth{
		Repo: repo, Passwords: loginPasswords{}, Limiter: loginLimiter{},
		Sessions: &memorySessionIndex{entries: map[string]uuid.UUID{}},
		Tokens:   fixedAuthTokens{raw: "new-token", replacementHash: []byte("new-hash")},
	}

	_, err := auth.Login(context.Background(), domain.LoginInput{
		Username: "user", Password: "valid-password", ClientProtocolVersion: 3,
	})
	if !domain.IsCode(err, domain.CodeInternal) {
		t.Fatalf("Login error = %v, want INTERNAL_ERROR", err)
	}
}

func (r *verifiedLoginRepository) ActiveDataSpace(context.Context, uuid.UUID, domain.DataMode) (domain.DataSpace, error) {
	return domain.DataSpace{ID: domain.LiveDataSpaceID()}, nil
}

func (r *verifiedLoginRepository) CreateVerifiedLoginSession(_ context.Context, input port.VerifiedLoginSession) (domain.Principal, error) {
	r.called, r.input = true, input
	return r.principal, r.err
}

type loginPasswords struct{}

func (loginPasswords) Hash(string) (string, error) { panic("login must not hash passwords") }
func (loginPasswords) Verify(password, hash string) (bool, error) {
	return password == "valid-password" && hash == "verified-encoded-hash", nil
}

type loginLimiter struct{}

func (loginLimiter) Allow(context.Context, string, int, time.Duration) (bool, error) {
	return true, nil
}

func TestLoginBindsCredentialSnapshotForEverySupportedProtocol(t *testing.T) {
	for _, protocol := range []int{0, 1, 2, 3} {
		t.Run(string(rune('0'+protocol)), func(t *testing.T) {
			repo := &verifiedLoginRepository{
				user:      domain.UserAuth{User: domain.User{ID: uuid.New(), IsActive: true}, PasswordHash: "verified-encoded-hash"},
				principal: domain.Principal{SessionID: uuid.New()},
			}
			index := &memorySessionIndex{entries: map[string]uuid.UUID{}}
			auth := Auth{Repo: repo, Passwords: loginPasswords{}, Limiter: loginLimiter{}, Sessions: index,
				Tokens: fixedAuthTokens{raw: "new-token", replacementHash: []byte("new-hash")}}
			result, err := auth.Login(context.Background(), domain.LoginInput{Username: "user", Password: "valid-password", ClientProtocolVersion: protocol})
			if err != nil {
				t.Fatal(err)
			}
			if !repo.called || repo.input.UserID != repo.user.ID || repo.input.VerifiedPasswordHash != repo.user.PasswordHash || string(repo.input.TokenHash) != "new-hash" || repo.input.ProtocolVersion != domain.NegotiatedClientProtocolVersion(protocol) {
				t.Fatal("login did not bind the verified credential snapshot and negotiated session policy")
			}
			if protocol < 2 && repo.input.DataSpaceID != domain.LiveDataSpaceID() || protocol >= 2 && repo.input.DataSpaceID != uuid.Nil {
				t.Fatalf("incorrect initial context for protocol %d", protocol)
			}
			if result.Token != "new-token" || index.entries["new-hash"] != repo.principal.SessionID {
				t.Fatal("successful login did not return/cache its committed session")
			}
		})
	}
}

func TestLoginNeverCachesSessionRejectedAfterCredentialVerification(t *testing.T) {
	repo := &verifiedLoginRepository{
		user: domain.UserAuth{User: domain.User{ID: uuid.New(), IsActive: true}, PasswordHash: "verified-encoded-hash"},
		err:  domain.NewError(domain.CodeInvalidCredentials, "Username atau kata sandi salah"),
	}
	index := &memorySessionIndex{entries: map[string]uuid.UUID{}}
	auth := Auth{Repo: repo, Passwords: loginPasswords{}, Limiter: loginLimiter{}, Sessions: index,
		Tokens: fixedAuthTokens{raw: "new-token", replacementHash: []byte("new-hash")}}
	result, err := auth.Login(context.Background(), domain.LoginInput{Username: "user", Password: "valid-password", ClientProtocolVersion: 3})
	if !domain.IsCode(err, domain.CodeInvalidCredentials) || !repo.called || result.Token != "" || len(index.entries) != 0 {
		t.Fatalf("credential race returned/cached an invalid session: %v", err)
	}
}
