package usecase

import (
	"context"
	"errors"
	"testing"

	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/domain"
	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/port"
	"github.com/google/uuid"
)

type authRecoveryRepository struct {
	port.Repository
	activeSpace        domain.DataSpace
	retiredPrincipal   domain.Principal
	retiredError       error
	recoverCalled      bool
	normalSwitchCalled bool
	recovered          domain.Principal
	currentHash        []byte
	replacementHash    []byte
	sessionPrincipal   domain.Principal
	sessionError       error
	sessionCalls       int
	tokenCalls         int
}

func (repository *authRecoveryRepository) ActiveDataSpace(context.Context, uuid.UUID, domain.DataMode) (domain.DataSpace, error) {
	return repository.activeSpace, nil
}

func (repository *authRecoveryRepository) PrincipalByTokenHash(context.Context, []byte) (domain.Principal, error) {
	repository.tokenCalls++
	return repository.retiredPrincipal, repository.retiredError
}

func (repository *authRecoveryRepository) PrincipalBySession(context.Context, uuid.UUID, []byte) (domain.Principal, error) {
	repository.sessionCalls++
	return repository.sessionPrincipal, repository.sessionError
}

func (repository *authRecoveryRepository) RecoverRetiredSandboxSession(
	_ context.Context,
	_ domain.Principal,
	currentHash, replacementHash []byte,
	_ uuid.UUID,
) (domain.Principal, error) {
	repository.recoverCalled = true
	repository.currentHash = append([]byte(nil), currentHash...)
	repository.replacementHash = append([]byte(nil), replacementHash...)
	return repository.recovered, nil
}

func (repository *authRecoveryRepository) SwitchSession(
	context.Context,
	domain.Principal,
	[]byte,
	[]byte,
	uuid.UUID,
) (domain.Principal, error) {
	repository.normalSwitchCalled = true
	return domain.Principal{}, nil
}

type fixedAuthTokens struct {
	raw             string
	hash            []byte
	replacementHash []byte
}

func (tokens fixedAuthTokens) New() (string, []byte, error) {
	return tokens.raw, append([]byte(nil), tokens.replacementHash...), nil
}

func (tokens fixedAuthTokens) Hash(string) ([]byte, error) {
	return append([]byte(nil), tokens.hash...), nil
}

type memorySessionIndex struct {
	entries map[string]uuid.UUID
}

func (index *memorySessionIndex) Get(_ context.Context, hash []byte) (uuid.UUID, bool) {
	id, ok := index.entries[string(hash)]
	return id, ok
}

func (index *memorySessionIndex) Set(_ context.Context, hash []byte, sessionID uuid.UUID) {
	index.entries[string(hash)] = sessionID
}

func (index *memorySessionIndex) Delete(_ context.Context, hash []byte) {
	delete(index.entries, string(hash))
}

func TestAuthenticatePreservesNarrowRetiredSandboxRecoveryIdentity(t *testing.T) {
	oldHash := []byte("old-token-hash")
	retired := domain.Principal{
		UserID: uuid.New(), SessionID: uuid.New(), ContextKind: domain.ContextTenant, TenantID: domain.InitialTenantID(), MembershipID: uuid.New(),
		DataSpaceID: uuid.New(), DataMode: domain.DataModeSandbox,
		SandboxGeneration: 3,
	}
	repository := &authRecoveryRepository{
		retiredPrincipal: retired,
		retiredError: domain.NewError(
			domain.CodeSandboxGenerationRetired,
			"Generasi Sandbox telah diganti",
		),
	}
	index := &memorySessionIndex{entries: map[string]uuid.UUID{}}
	service := Auth{
		Repo:     repository,
		Tokens:   fixedAuthTokens{hash: oldHash},
		Sessions: index,
	}

	authentication, err := service.Authenticate(context.Background(), "retired-token")
	if !domain.IsCode(err, domain.CodeSandboxGenerationRetired) {
		t.Fatalf("Authenticate error = %v", err)
	}
	if !authentication.RecoverableRetiredSandbox || authentication.Principal != retired ||
		string(authentication.TokenHash) != string(oldHash) {
		t.Fatalf("recoverable authentication = %+v", authentication)
	}
	if len(index.entries) != 0 {
		t.Fatalf("retired session was cached: %+v", index.entries)
	}
}

func TestAuthenticatePreservesTransientDatabaseFailureAndCachedIndex(t *testing.T) {
	hash := []byte("valid-token-hash")
	sessionID := uuid.New()
	repository := &authRecoveryRepository{
		sessionError: domain.WrapInternal(errors.New("database waking"), "authorize session"),
	}
	index := &memorySessionIndex{entries: map[string]uuid.UUID{string(hash): sessionID}}
	service := Auth{Repo: repository, Tokens: fixedAuthTokens{hash: hash}, Sessions: index}

	_, err := service.Authenticate(context.Background(), "valid-token")
	if !domain.IsCode(err, domain.CodeInternal) {
		t.Fatalf("Authenticate error = %v, want INTERNAL_ERROR", err)
	}
	if index.entries[string(hash)] != sessionID {
		t.Fatal("transient database failure evicted the cached session mapping")
	}
	if repository.tokenCalls != 0 {
		t.Fatalf("authoritative token lookup calls = %d, want 0", repository.tokenCalls)
	}
}

func TestAuthenticateFallsBackOnlyForStaleCachedMapping(t *testing.T) {
	hash := []byte("valid-token-hash")
	staleSessionID := uuid.New()
	principal := domain.Principal{SessionID: uuid.New(), UserID: uuid.New()}
	repository := &authRecoveryRepository{
		sessionError:     domain.NewError(domain.CodeNotFound, "Data tidak ditemukan"),
		retiredPrincipal: principal,
	}
	index := &memorySessionIndex{entries: map[string]uuid.UUID{string(hash): staleSessionID}}
	service := Auth{Repo: repository, Tokens: fixedAuthTokens{hash: hash}, Sessions: index}

	authentication, err := service.Authenticate(context.Background(), "valid-token")
	if err != nil {
		t.Fatalf("Authenticate error = %v", err)
	}
	if authentication.Principal.SessionID != principal.SessionID {
		t.Fatalf("principal = %+v", authentication.Principal)
	}
	if index.entries[string(hash)] != principal.SessionID {
		t.Fatal("authoritative session mapping was not refreshed")
	}
}

func TestAuthenticateCacheMissPreservesDatabaseFailure(t *testing.T) {
	hash := []byte("valid-token-hash")
	repository := &authRecoveryRepository{
		retiredError: domain.WrapInternal(errors.New("database waking"), "find session token"),
	}
	service := Auth{
		Repo: repository, Tokens: fixedAuthTokens{hash: hash},
		Sessions: &memorySessionIndex{entries: map[string]uuid.UUID{}},
	}

	_, err := service.Authenticate(context.Background(), "valid-token")
	if !domain.IsCode(err, domain.CodeInternal) {
		t.Fatalf("Authenticate error = %v, want INTERNAL_ERROR", err)
	}
}

func TestSwitchModeUsesOneTimeRecoveryAndAllowsProductionRollback(t *testing.T) {
	oldHash := []byte("old-token-hash")
	newHash := []byte("new-token-hash")
	production := domain.DataSpace{
		ID: uuid.New(), Mode: domain.DataModeProduction,
		Status: domain.DataSpaceStatusActive, Generation: 1,
	}
	retired := domain.Principal{
		UserID: uuid.New(), SessionID: uuid.New(), ContextKind: domain.ContextTenant, TenantID: domain.InitialTenantID(), MembershipID: uuid.New(),
		DataSpaceID: uuid.New(), DataMode: domain.DataModeSandbox,
		SandboxGeneration: 8,
	}
	recovered := retired
	recovered.SessionID = uuid.New()
	recovered.DataSpaceID = production.ID
	recovered.DataMode = domain.DataModeProduction
	recovered.SandboxGeneration = 0
	repository := &authRecoveryRepository{
		activeSpace: production,
		recovered:   recovered,
	}
	index := &memorySessionIndex{entries: map[string]uuid.UUID{
		string(oldHash): retired.SessionID,
	}}
	service := Auth{
		Repo: repository,
		Tokens: fixedAuthTokens{
			raw: "replacement-token", hash: oldHash, replacementHash: newHash,
		},
		Sessions: index,
		// Production recovery intentionally remains available when the Sandbox
		// rollout flag is disabled.
		SandboxEnabled: false,
	}

	result, err := service.SwitchMode(context.Background(), Authentication{
		Principal: retired, TokenHash: oldHash, RecoverableRetiredSandbox: true,
	}, domain.DataModeProduction)
	if err != nil {
		t.Fatalf("recover to Production: %v", err)
	}
	if result.Token != "replacement-token" || result.Principal != recovered {
		t.Fatalf("recovery result = %+v", result)
	}
	if !repository.recoverCalled || repository.normalSwitchCalled ||
		string(repository.currentHash) != string(oldHash) ||
		string(repository.replacementHash) != string(newHash) {
		t.Fatalf("repository recovery call = %+v", repository)
	}
	if _, exists := index.entries[string(oldHash)]; exists {
		t.Fatal("old retired token remained in session index")
	}
	if id := index.entries[string(newHash)]; id != recovered.SessionID {
		t.Fatalf("replacement session cache = %s, want %s", id, recovered.SessionID)
	}
}
