package postgres

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/domain"
	"github.com/fahmialfareza/sewa-motor-app/apps/backend/migrations"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	gormpostgres "gorm.io/driver/postgres"
	"gorm.io/gorm"
)

// This test intentionally uses a disposable schema in the configured database.
// It is skipped in ordinary unit-test runs and can be enabled with DATABASE_URL.
func TestSandboxLifecycleClonesProductionRevokesSessionsAndPurgesOnlyAtExpiry(t *testing.T) {
	store := openSandboxLifecycleStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	actor, terminalID := seedSandboxLifecyclePrincipal(t, ctx, store)
	if _, err := store.ActiveDataSpace(ctx, domain.InitialTenantID(), domain.DataModeSandbox); !domain.IsCode(err, domain.CodeNotFound) {
		t.Fatalf("migration unexpectedly activated Sandbox: %v", err)
	}
	productionPackagesAtActivation, err := store.ListPackages(ctx, domain.LiveDataSpaceID(), false)
	if err != nil {
		t.Fatalf("list production packages before activation: %v", err)
	}

	// API replicas may start together immediately after the feature flag is
	// enabled. Every activation call must converge on the exact same generation
	// without duplicate clones, sync seeds, or audit history.
	type activationResult struct {
		space domain.DataSpace
		err   error
	}
	const replicaCount = 4
	start := make(chan struct{})
	results := make(chan activationResult, replicaCount)
	for range replicaCount {
		go func() {
			<-start
			space, activationErr := store.EnsureSandbox(ctx, domain.InitialTenantID())
			results <- activationResult{space: space, err: activationErr}
		}()
	}
	close(start)

	initialSandbox := domain.DataSpace{}
	for replica := 0; replica < replicaCount; replica++ {
		result := <-results
		if result.err != nil {
			t.Fatalf("activate initial Sandbox from replica %d: %v", replica, result.err)
		}
		if initialSandbox.ID == uuid.Nil {
			initialSandbox = result.space
		} else if result.space.ID != initialSandbox.ID {
			t.Fatalf("replicas activated different Sandbox spaces: %s and %s", initialSandbox.ID, result.space.ID)
		}
	}
	if initialSandbox.Generation != 1 || initialSandbox.Status != domain.DataSpaceStatusActive {
		t.Fatalf("initial Sandbox = %+v", initialSandbox)
	}
	initialClones, err := store.ListPackages(ctx, initialSandbox.ID, false)
	if err != nil {
		t.Fatalf("list initial Sandbox package clones: %v", err)
	}
	assertProductionPackageClones(t, productionPackagesAtActivation, initialClones)
	assertInitialSandboxSeeds(t, ctx, store, initialSandbox.ID, len(initialClones))

	idempotentSandbox, err := store.EnsureSandbox(ctx, domain.InitialTenantID())
	if err != nil || idempotentSandbox.ID != initialSandbox.ID {
		t.Fatalf("idempotent Sandbox activation = %+v error=%v", idempotentSandbox, err)
	}
	assertInitialSandboxSeeds(t, ctx, store, initialSandbox.ID, len(initialClones))
	if err = store.ConfigureSandbox(ctx, actor, false); err != nil {
		t.Fatalf("disable tenant Sandbox: %v", err)
	}
	var override *bool
	if err = store.Pool.QueryRow(ctx, `SELECT sandbox_enabled_override FROM tenants WHERE id=$1`, actor.TenantID).Scan(&override); err != nil || override == nil || *override {
		t.Fatalf("disabled override=%v error=%v", override, err)
	}
	retainedSandbox, err := store.ActiveDataSpace(ctx, actor.TenantID, domain.DataModeSandbox)
	if err != nil || retainedSandbox.ID != initialSandbox.ID {
		t.Fatalf("disable removed active Sandbox: %+v error=%v", retainedSandbox, err)
	}
	if err = store.ConfigureSandbox(ctx, actor, true); err != nil {
		t.Fatalf("re-enable tenant Sandbox: %v", err)
	}
	if err = store.ConfigureSandbox(ctx, actor, true); err != nil {
		t.Fatalf("idempotent tenant Sandbox enable: %v", err)
	}
	var configurationEvents int
	if err = store.Pool.QueryRow(ctx, `SELECT count(*) FROM platform_audit_events WHERE tenant_id=$1 AND event_type='tenant.sandbox_enabled_changed'`, actor.TenantID).Scan(&configurationEvents); err != nil || configurationEvents != 2 {
		t.Fatalf("configuration audit count=%d error=%v", configurationEvents, err)
	}
	productionPackage, err := store.CreatePackage(ctx, actor, domain.CreatePackageInput{
		Code:         "LIFECYCLE",
		Name:         "Paket Lifecycle",
		Description:  "Paket produksi untuk pengujian lifecycle Sandbox",
		UnitPrice:    125_000,
		ChangeReason: "Pengujian integrasi",
	})
	if err != nil {
		t.Fatalf("create production package: %v", err)
	}
	productionPackage, err = store.UpdatePackage(ctx, actor, productionPackage.ID, domain.UpdatePackageInput{
		Name:         "Paket Lifecycle Revisi 2",
		Description:  "Snapshot produksi terbaru harus diklon",
		UnitPrice:    135_000,
		ChangeReason: "Pastikan reset memakai revisi aktif",
	})
	if err != nil {
		t.Fatalf("revise production package: %v", err)
	}

	productionPackagesBefore, err := store.ListPackages(ctx, domain.LiveDataSpaceID(), false)
	if err != nil {
		t.Fatalf("list production packages before reset: %v", err)
	}
	if len(productionPackagesBefore) < 3 {
		t.Fatalf("production package count = %d, want the seeds plus lifecycle package", len(productionPackagesBefore))
	}

	oldSandbox, err := store.ActiveDataSpace(ctx, domain.InitialTenantID(), domain.DataModeSandbox)
	if err != nil {
		t.Fatalf("read initial Sandbox generation: %v", err)
	}
	oldSandboxSessionID := uuid.New()
	if _, err = store.Pool.Exec(ctx, `
		INSERT INTO sessions (id, user_id, terminal_id, token_hash, data_space_id)
		VALUES ($1,$2,$3,$4,$5)`,
		oldSandboxSessionID, actor.UserID, terminalID, integrationBytes(31), oldSandbox.ID,
	); err != nil {
		t.Fatalf("create old Sandbox session: %v", err)
	}
	oldSandboxActor := actor
	oldSandboxActor.SessionID = oldSandboxSessionID
	oldSandboxActor.DataSpaceID = oldSandbox.ID
	oldSandboxActor.DataMode = domain.DataModeSandbox
	oldSandboxActor.SandboxGeneration = oldSandbox.Generation
	oldSandboxOnlyPackage, err := store.CreatePackage(ctx, oldSandboxActor, domain.CreatePackageInput{
		Code:         "SANDBOX-ONLY",
		Name:         "Paket Khusus Sandbox Lama",
		Description:  "Tidak boleh ikut ke generasi berikutnya",
		UnitPrice:    1_000,
		ChangeReason: "Pengujian isolasi reset",
	})
	if err != nil {
		t.Fatalf("create package in old Sandbox: %v", err)
	}

	// Put the retirement far enough in the past that PostgreSQL's append-only
	// guard agrees it is expired, while still testing the janitor's exact
	// caller-supplied cutoff below.
	resetAt := time.Now().UTC().Add(-48 * time.Hour).Truncate(time.Microsecond)
	store.Now = func() time.Time { return resetAt }
	reset, err := store.ResetSandbox(ctx, actor, oldSandbox.Generation, 24*time.Hour)
	if err != nil {
		t.Fatalf("reset Sandbox: %v", err)
	}
	if reset.Previous.ID != oldSandbox.ID || reset.Previous.Status != domain.DataSpaceStatusRetired {
		t.Fatalf("retired generation = %+v, want old generation %s", reset.Previous, oldSandbox.ID)
	}
	if reset.Current.Generation != oldSandbox.Generation+1 || reset.Current.Status != domain.DataSpaceStatusActive {
		t.Fatalf("new generation = %+v", reset.Current)
	}
	if reset.ClonedPackageCount != len(productionPackagesBefore) {
		t.Fatalf("cloned package count = %d, want %d", reset.ClonedPackageCount, len(productionPackagesBefore))
	}
	if reset.RevokedSessionCount != 1 {
		t.Fatalf("revoked Sandbox sessions = %d, want 1", reset.RevokedSessionCount)
	}

	var revokedAt *time.Time
	var revokedReason *string
	if err = store.Pool.QueryRow(ctx, `
		SELECT revoked_at, revoked_reason FROM sessions WHERE id = $1`, oldSandboxSessionID,
	).Scan(&revokedAt, &revokedReason); err != nil {
		t.Fatalf("read retired Sandbox session: %v", err)
	}
	if revokedAt == nil || revokedReason == nil || *revokedReason != "sandbox_generation_retired" {
		t.Fatalf("retired Sandbox session revoked_at=%v reason=%v", revokedAt, revokedReason)
	}
	for name, authorize := range map[string]func() error{
		"session lookup": func() error {
			_, authorizeErr := store.PrincipalBySession(
				ctx,
				oldSandboxSessionID,
				integrationBytes(31),
			)
			return authorizeErr
		},
		"token lookup": func() error {
			_, authorizeErr := store.PrincipalByTokenHash(ctx, integrationBytes(31))
			return authorizeErr
		},
	} {
		if authorizeErr := authorize(); !domain.IsCode(
			authorizeErr,
			domain.CodeSandboxGenerationRetired,
		) {
			t.Fatalf("%s for retired Sandbox returned %v", name, authorizeErr)
		}
	}
	var productionRevokedAt *time.Time
	if err = store.Pool.QueryRow(ctx, `SELECT revoked_at FROM sessions WHERE id = $1`, actor.SessionID).Scan(&productionRevokedAt); err != nil {
		t.Fatalf("read production session after reset: %v", err)
	}
	if productionRevokedAt != nil {
		t.Fatalf("production session was revoked at %v", *productionRevokedAt)
	}

	clones, err := store.ListPackages(ctx, reset.Current.ID, false)
	if err != nil {
		t.Fatalf("list reset Sandbox packages: %v", err)
	}
	assertProductionPackageClones(t, productionPackagesBefore, clones)
	for _, clone := range clones {
		if clone.Code == oldSandboxOnlyPackage.Code || clone.ID == oldSandboxOnlyPackage.ID {
			t.Fatalf("old Sandbox-only package leaked into the new generation: %+v", clone)
		}
	}
	if _, err = store.GetPackage(ctx, reset.Current.ID, productionPackage.ID); !domain.IsCode(err, domain.CodeNotFound) {
		t.Fatalf("production ID looked up through Sandbox returned %v, want NOT_FOUND", err)
	}
	if _, err = store.GetPackage(ctx, domain.LiveDataSpaceID(), productionPackage.ID); err != nil {
		t.Fatalf("production package became inaccessible after reset: %v", err)
	}
	if _, err = store.CreatePackage(ctx, oldSandboxActor, domain.CreatePackageInput{
		Code: "RETIRED-WRITE", Name: "Tidak boleh", UnitPrice: 1_000,
	}); !domain.IsCode(err, domain.CodeSandboxGenerationRetired) {
		t.Fatalf("write through retired generation returned %v, want SANDBOX_GENERATION_RETIRED", err)
	}

	assertPurgeGuardRejectsOtherSpace(t, ctx, store, oldSandbox.ID, domain.LiveDataSpaceID())
	assertPurgeGuardRejectsOtherSpace(t, ctx, store, reset.Current.ID, reset.Current.ID)

	if reset.Previous.PurgeAfter == nil {
		t.Fatal("retired generation has no purge_after")
	}
	expiresAt := reset.Previous.PurgeAfter.UTC().Truncate(time.Microsecond)
	beforeExpiry, err := store.CleanupExpiredSandboxes(ctx, expiresAt.Add(-time.Microsecond))
	if err != nil {
		t.Fatalf("cleanup before expiry: %v", err)
	}
	if beforeExpiry.PurgedGenerationCount != 0 || beforeExpiry.PurgedRowCount != 0 {
		t.Fatalf("cleanup before expiry removed data: %+v", beforeExpiry)
	}
	assertDataSpaceStatus(t, ctx, store, oldSandbox.ID, domain.DataSpaceStatusRetired)
	assertDataSpaceHasRows(t, ctx, store, oldSandbox.ID)

	activePackagesBeforeCleanup, err := store.ListPackages(ctx, reset.Current.ID, false)
	if err != nil {
		t.Fatalf("list active Sandbox before cleanup: %v", err)
	}
	productionPackagesAtCleanup, err := store.ListPackages(ctx, domain.LiveDataSpaceID(), false)
	if err != nil {
		t.Fatalf("list production before cleanup: %v", err)
	}
	exactExpiry, err := store.CleanupExpiredSandboxes(ctx, expiresAt)
	if err != nil {
		t.Fatalf("cleanup at exact expiry: %v", err)
	}
	if exactExpiry.PurgedGenerationCount != 1 || exactExpiry.PurgedRowCount == 0 {
		t.Fatalf("cleanup at exact expiry = %+v, want one non-empty generation", exactExpiry)
	}
	assertDataSpaceStatus(t, ctx, store, oldSandbox.ID, domain.DataSpaceStatusPurged)
	assertDataSpaceIsEmpty(t, ctx, store, oldSandbox.ID)

	activePackagesAfterCleanup, err := store.ListPackages(ctx, reset.Current.ID, false)
	if err != nil {
		t.Fatalf("list active Sandbox after cleanup: %v", err)
	}
	productionPackagesAfterCleanup, err := store.ListPackages(ctx, domain.LiveDataSpaceID(), false)
	if err != nil {
		t.Fatalf("list production after cleanup: %v", err)
	}
	if len(activePackagesAfterCleanup) != len(activePackagesBeforeCleanup) {
		t.Fatalf("active Sandbox package count changed from %d to %d", len(activePackagesBeforeCleanup), len(activePackagesAfterCleanup))
	}
	if len(productionPackagesAfterCleanup) != len(productionPackagesAtCleanup) {
		t.Fatalf("production package count changed from %d to %d", len(productionPackagesAtCleanup), len(productionPackagesAfterCleanup))
	}
	for _, eventType := range []string{"sandbox.reset", "sandbox.purged"} {
		var count int
		if err = store.Pool.QueryRow(ctx, `
			SELECT count(*) FROM audit_events
			WHERE data_space_id = $1 AND event_type = $2`, domain.LiveDataSpaceID(), eventType,
		).Scan(&count); err != nil {
			t.Fatalf("count %s production audit events: %v", eventType, err)
		}
		if count != 1 {
			t.Fatalf("%s production audit event count = %d, want 1", eventType, count)
		}
	}
}

func TestSwitchSessionWaitingBehindResetRejectsRetiredTarget(t *testing.T) {
	store := openSandboxLifecycleStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	actor, _ := seedSandboxLifecyclePrincipal(t, ctx, store)
	sandbox, err := store.EnsureSandbox(ctx, domain.InitialTenantID())
	if err != nil {
		t.Fatalf("activate Sandbox: %v", err)
	}
	resetLock := holdSandboxGenerationLock(t, ctx, store)
	defer resetLock.Rollback(ctx)

	tokenHash := integrationBytes(53)
	type switchResult struct {
		principal domain.Principal
		err       error
	}
	result := make(chan switchResult, 1)
	go func() {
		principal, switchErr := store.SwitchSession(
			ctx, actor, integrationBytes(23), tokenHash, sandbox.ID,
		)
		result <- switchResult{principal: principal, err: switchErr}
	}()
	waitForSandboxGenerationLockWaiters(t, ctx, resetLock, "ShareLock", 1)

	replacement := replaceSandboxGenerationUnderLock(t, ctx, resetLock, sandbox)
	if err = resetLock.Commit(ctx); err != nil {
		t.Fatalf("commit competing reset: %v", err)
	}

	switched := <-result
	if !domain.IsCode(switched.err, domain.CodeSandboxGenerationRetired) {
		t.Fatalf("mode switch returned principal=%+v error=%v", switched.principal, switched.err)
	}
	var currentRevokedAt *time.Time
	if err = store.Pool.QueryRow(ctx, `
		SELECT revoked_at FROM sessions WHERE id = $1`, actor.SessionID,
	).Scan(&currentRevokedAt); err != nil {
		t.Fatalf("read current production session: %v", err)
	}
	if currentRevokedAt != nil {
		t.Fatalf("failed mode switch revoked the current session at %v", *currentRevokedAt)
	}
	var leakedSessions int
	if err = store.Pool.QueryRow(ctx, `
		SELECT count(*) FROM sessions WHERE token_hash = $1`, tokenHash,
	).Scan(&leakedSessions); err != nil {
		t.Fatalf("count failed switched sessions: %v", err)
	}
	if leakedSessions != 0 {
		t.Fatalf("failed mode switch left %d target sessions", leakedSessions)
	}
	active, err := store.ActiveDataSpace(ctx, domain.InitialTenantID(), domain.DataModeSandbox)
	if err != nil || active.ID != replacement.ID {
		t.Fatalf("active Sandbox = %+v, error=%v; want %s", active, err, replacement.ID)
	}
}

func TestConcurrentSwitchSessionConsumesCurrentSessionOnce(t *testing.T) {
	store := openSandboxLifecycleStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	actor, _ := seedSandboxLifecyclePrincipal(t, ctx, store)
	sandbox, err := store.EnsureSandbox(ctx, domain.InitialTenantID())
	if err != nil {
		t.Fatalf("activate Sandbox: %v", err)
	}
	type switchResult struct {
		principal domain.Principal
		err       error
	}
	start := make(chan struct{})
	results := make(chan switchResult, 2)
	for index := range 2 {
		tokenHash := integrationBytes(byte(61 + index))
		go func() {
			<-start
			principal, switchErr := store.SwitchSession(
				ctx, actor, integrationBytes(23), tokenHash, sandbox.ID,
			)
			results <- switchResult{principal: principal, err: switchErr}
		}()
	}
	close(start)

	succeeded := 0
	rejected := 0
	for range 2 {
		result := <-results
		switch {
		case result.err == nil:
			succeeded++
			if result.principal.DataSpaceID != sandbox.ID ||
				result.principal.DataMode != domain.DataModeSandbox {
				t.Errorf("switched principal = %+v", result.principal)
			}
		case domain.IsCode(result.err, domain.CodeUnauthorized):
			rejected++
		default:
			t.Errorf("concurrent mode switch returned %v", result.err)
		}
	}
	if succeeded != 1 || rejected != 1 {
		t.Fatalf("concurrent switches succeeded=%d rejected=%d, want 1/1", succeeded, rejected)
	}
	var activeTargetSessions int
	if err = store.Pool.QueryRow(ctx, `
		SELECT count(*) FROM sessions
		WHERE user_id = $1 AND data_space_id = $2 AND revoked_at IS NULL`,
		actor.UserID, sandbox.ID,
	).Scan(&activeTargetSessions); err != nil {
		t.Fatalf("count active target sessions: %v", err)
	}
	if activeTargetSessions != 1 {
		t.Fatalf("active target sessions = %d, want 1", activeTargetSessions)
	}
}

func TestRetiredSandboxSessionRecoveryIsOneTimeAndSecurityBound(t *testing.T) {
	store := openSandboxLifecycleStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	actor, terminalID := seedSandboxLifecyclePrincipal(t, ctx, store)
	securityActor, _ := seedSandboxLifecyclePrincipalWithToken(
		t, ctx, store, integrationBytes(24),
	)
	sandbox, err := store.EnsureSandbox(ctx, domain.InitialTenantID())
	if err != nil {
		t.Fatalf("activate Sandbox: %v", err)
	}

	type retiredSession struct {
		id        uuid.UUID
		userID    uuid.UUID
		terminal  *uuid.UUID
		tokenHash []byte
	}
	sessions := []retiredSession{
		{id: uuid.New(), userID: actor.UserID, terminal: &terminalID, tokenHash: integrationBytes(81)},
		{id: uuid.New(), userID: actor.UserID, terminal: &terminalID, tokenHash: integrationBytes(82)},
		{id: uuid.New(), userID: actor.UserID, terminal: &terminalID, tokenHash: integrationBytes(83)},
		{id: uuid.New(), userID: securityActor.UserID, terminal: securityActor.TerminalID, tokenHash: integrationBytes(84)},
	}
	for _, session := range sessions {
		if _, err = store.Pool.Exec(ctx, `
			INSERT INTO sessions (id, user_id, terminal_id, token_hash, data_space_id)
			VALUES ($1,$2,$3,$4,$5)`,
			session.id, session.userID, session.terminal, session.tokenHash, sandbox.ID,
		); err != nil {
			t.Fatalf("create recoverable Sandbox session: %v", err)
		}
	}
	type unrelatedRevocation struct {
		id        uuid.UUID
		reason    string
		tokenHash []byte
	}
	unrelatedRevocations := make([]unrelatedRevocation, 0, 5)
	for index, reason := range []string{
		"logout", "password_changed", "user_access_changed", "terminal_revoked",
		// Matching the reserved reason is still insufficient: a recoverable
		// session must have been revoked at the exact generation retirement.
		"sandbox_generation_retired",
	} {
		revocation := unrelatedRevocation{
			id: uuid.New(), reason: reason, tokenHash: integrationBytes(byte(101 + index)),
		}
		if _, err = store.Pool.Exec(ctx, `
			INSERT INTO sessions (
				id, user_id, terminal_id, token_hash, data_space_id,
				revoked_at, revoked_reason
			) VALUES ($1,$2,$3,$4,$5,clock_timestamp() - interval '1 hour',$6)`,
			revocation.id, actor.UserID, terminalID, revocation.tokenHash,
			sandbox.ID, revocation.reason,
		); err != nil {
			t.Fatalf("create %s-revoked Sandbox session: %v", reason, err)
		}
		unrelatedRevocations = append(unrelatedRevocations, revocation)
	}

	reset, err := store.ResetSandbox(ctx, actor, sandbox.Generation, 30*24*time.Hour)
	if err != nil {
		t.Fatalf("reset Sandbox: %v", err)
	}

	// Retiring the containing generation must never upgrade older unrelated
	// revocations into recovery credentials.
	for _, revocation := range unrelatedRevocations {
		for lookupName, lookup := range map[string]func() (domain.Principal, error){
			"session": func() (domain.Principal, error) {
				return store.PrincipalBySession(ctx, revocation.id, revocation.tokenHash)
			},
			"token": func() (domain.Principal, error) {
				return store.PrincipalByTokenHash(ctx, revocation.tokenHash)
			},
		} {
			lookedUp, lookupErr := lookup()
			if revocation.reason == "terminal_revoked" {
				if !domain.IsCode(lookupErr, domain.CodeMembershipInactive) {
					t.Fatalf("terminal recovery must be context-only: %v", lookupErr)
				}
				continue
			}
			if domain.IsCode(lookupErr, domain.CodeSandboxGenerationRetired) ||
				lookedUp.SessionID != uuid.Nil {
				t.Fatalf(
					"%s lookup classified %s revocation as recoverable: principal=%+v error=%v",
					lookupName, revocation.reason, lookedUp, lookupErr,
				)
			}
		}
		forged := actor
		forged.SessionID = revocation.id
		forged.DataSpaceID = sandbox.ID
		forged.DataMode = domain.DataModeSandbox
		forged.SandboxGeneration = sandbox.Generation
		if _, recoveryErr := store.RecoverRetiredSandboxSession(
			ctx, forged, revocation.tokenHash, integrationBytes(110), reset.Current.ID,
		); !domain.IsCode(recoveryErr, domain.CodeUnauthorized) {
			t.Fatalf("%s revocation recovery returned %v", revocation.reason, recoveryErr)
		}
	}

	retiredPrincipal, authorizeErr := store.PrincipalBySession(
		ctx, sessions[0].id, sessions[0].tokenHash,
	)
	if !domain.IsCode(authorizeErr, domain.CodeSandboxGenerationRetired) {
		t.Fatalf("authorize retired session: principal=%+v error=%v", retiredPrincipal, authorizeErr)
	}
	if retiredPrincipal.SessionID != sessions[0].id ||
		retiredPrincipal.UserID != actor.UserID ||
		retiredPrincipal.DataSpaceID != sandbox.ID ||
		retiredPrincipal.DataMode != domain.DataModeSandbox ||
		retiredPrincipal.SandboxGeneration != sandbox.Generation {
		t.Fatalf("recoverable retired principal = %+v", retiredPrincipal)
	}

	// A bad token cannot consume the recovery capability.
	if _, err = store.RecoverRetiredSandboxSession(
		ctx, retiredPrincipal, integrationBytes(99), integrationBytes(91), reset.Current.ID,
	); !domain.IsCode(err, domain.CodeUnauthorized) {
		t.Fatalf("recovery with wrong token returned %v", err)
	}

	recoveredSandbox, err := store.RecoverRetiredSandboxSession(
		ctx, retiredPrincipal, sessions[0].tokenHash, integrationBytes(91), reset.Current.ID,
	)
	if err != nil {
		t.Fatalf("recover into active Sandbox: %v", err)
	}
	if recoveredSandbox.DataSpaceID != reset.Current.ID ||
		recoveredSandbox.DataMode != domain.DataModeSandbox ||
		recoveredSandbox.SandboxGeneration != reset.Current.Generation {
		t.Fatalf("recovered Sandbox principal = %+v", recoveredSandbox)
	}
	if _, err = store.PrincipalBySession(
		ctx, recoveredSandbox.SessionID, integrationBytes(91),
	); err != nil {
		t.Fatalf("authorize recovered Sandbox session: %v", err)
	}
	if _, err = store.RecoverRetiredSandboxSession(
		ctx, retiredPrincipal, sessions[0].tokenHash, integrationBytes(92), reset.Current.ID,
	); !domain.IsCode(err, domain.CodeUnauthorized) {
		t.Fatalf("second recovery returned %v, want UNAUTHORIZED", err)
	}
	var consumedReason string
	if err = store.Pool.QueryRow(ctx, `
		SELECT revoked_reason FROM sessions WHERE id = $1`, sessions[0].id,
	).Scan(&consumedReason); err != nil {
		t.Fatalf("read consumed recovery session: %v", err)
	}
	if consumedReason != "sandbox_generation_recovered" {
		t.Fatalf("consumed recovery reason = %q", consumedReason)
	}

	// Recovery to Production is available for rollback even though the source
	// session belongs to a retired Sandbox generation.
	productionPrincipal, err := store.PrincipalBySession(ctx, sessions[1].id, sessions[1].tokenHash)
	if !domain.IsCode(err, domain.CodeSandboxGenerationRetired) {
		t.Fatalf("read second retired principal: %v", err)
	}
	recoveredProduction, err := store.RecoverRetiredSandboxSession(
		ctx, productionPrincipal, sessions[1].tokenHash, integrationBytes(93), domain.LiveDataSpaceID(),
	)
	if err != nil {
		t.Fatalf("recover into Production: %v", err)
	}
	if recoveredProduction.DataSpaceID != domain.LiveDataSpaceID() ||
		recoveredProduction.DataMode != domain.DataModeProduction ||
		recoveredProduction.SandboxGeneration != 0 {
		t.Fatalf("recovered Production principal = %+v", recoveredProduction)
	}

	// A terminal change after reset invalidates remaining recovery capabilities.
	var retiredAt time.Time
	if err = store.Pool.QueryRow(ctx, `
		SELECT revoked_at FROM sessions WHERE id = $1`, sessions[2].id,
	).Scan(&retiredAt); err != nil {
		t.Fatalf("read terminal-bound retirement time: %v", err)
	}
	if _, err = store.Pool.Exec(ctx, `
		UPDATE terminals SET updated_at = $2 WHERE id = $1`,
		terminalID, retiredAt.Add(time.Microsecond),
	); err != nil {
		t.Fatalf("mark terminal changed after reset: %v", err)
	}
	terminalBoundPrincipal, principalErr := store.PrincipalBySession(
		ctx, sessions[2].id, sessions[2].tokenHash,
	)
	if !domain.IsCode(principalErr, domain.CodeSandboxGenerationRetired) {
		t.Fatalf("read terminal-bound retired principal: %v", principalErr)
	}
	if _, err = store.RecoverRetiredSandboxSession(
		ctx, terminalBoundPrincipal, sessions[2].tokenHash, integrationBytes(94), reset.Current.ID,
	); !domain.IsCode(err, domain.CodeUnauthorized) {
		t.Fatalf("recovery after terminal change returned %v", err)
	}

	// The same rule prevents a token from bypassing a later password/profile or
	// access mutation on its shared user.
	if err = store.Pool.QueryRow(ctx, `
		SELECT revoked_at FROM sessions WHERE id = $1`, sessions[3].id,
	).Scan(&retiredAt); err != nil {
		t.Fatalf("read user-bound retirement time: %v", err)
	}
	if _, err = store.Pool.Exec(ctx, `
		UPDATE users SET updated_at = $2 WHERE id = $1`,
		securityActor.UserID, retiredAt.Add(time.Microsecond),
	); err != nil {
		t.Fatalf("mark user changed after reset: %v", err)
	}
	userBoundPrincipal, principalErr := store.PrincipalBySession(
		ctx, sessions[3].id, sessions[3].tokenHash,
	)
	if !domain.IsCode(principalErr, domain.CodeSandboxGenerationRetired) {
		t.Fatalf("read user-bound retired principal: %v", principalErr)
	}
	if _, err = store.RecoverRetiredSandboxSession(
		ctx, userBoundPrincipal, sessions[3].tokenHash, integrationBytes(95), reset.Current.ID,
	); !domain.IsCode(err, domain.CodeUnauthorized) {
		t.Fatalf("recovery after user change returned %v", err)
	}
}

func TestSandboxLifecycleWaitersRefreshAfterGenerationLock(t *testing.T) {
	store := openSandboxLifecycleStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()

	actor, _ := seedSandboxLifecyclePrincipal(t, ctx, store)
	resetAt := time.Now().UTC().Add(-48 * time.Hour).Truncate(time.Microsecond)
	store.Now = func() time.Time { return resetAt }
	sandbox, err := store.EnsureSandbox(ctx, domain.InitialTenantID())
	if err != nil {
		t.Fatalf("activate Sandbox: %v", err)
	}

	resetBlocker := holdSandboxGenerationLock(t, ctx, store)
	defer resetBlocker.Rollback(ctx)
	type resetResult struct {
		result domain.SandboxResetResult
		err    error
	}
	resetResults := make(chan resetResult, 2)
	for range 2 {
		go func() {
			result, resetErr := store.ResetSandbox(ctx, actor, sandbox.Generation, 24*time.Hour)
			resetResults <- resetResult{result: result, err: resetErr}
		}()
	}
	// Tenant locking serializes lifecycle changes before the generation lock.
	waitForSandboxGenerationLockWaiters(t, ctx, resetBlocker, "ExclusiveLock", 1)
	if err = resetBlocker.Commit(ctx); err != nil {
		t.Fatalf("release reset blocker: %v", err)
	}

	resetSucceeded := 0
	resetConflictedWithGeneration := 0
	for range 2 {
		result := <-resetResults
		if result.err == nil {
			resetSucceeded++
			continue
		}
		domainErr := domain.AsError(result.err)
		if domainErr.Code == domain.CodeConflict &&
			domainErr.Details["currentGeneration"] == sandbox.Generation+1 {
			resetConflictedWithGeneration++
			continue
		}
		t.Errorf("losing reset returned %v", result.err)
	}
	if resetSucceeded != 1 || resetConflictedWithGeneration != 1 {
		t.Fatalf(
			"concurrent resets succeeded=%d generation-conflicted=%d, want 1/1",
			resetSucceeded,
			resetConflictedWithGeneration,
		)
	}

	cleanupBlocker := holdSandboxGenerationLock(t, ctx, store)
	defer cleanupBlocker.Rollback(ctx)
	type cleanupResult struct {
		result domain.SandboxCleanupResult
		err    error
	}
	cleanupResults := make(chan cleanupResult, 2)
	for range 2 {
		go func() {
			result, cleanupErr := store.CleanupExpiredSandboxes(ctx, time.Now().UTC())
			cleanupResults <- cleanupResult{result: result, err: cleanupErr}
		}()
	}
	// Cleanup contenders serialize on the tenant row before this lock as well.
	waitForSandboxGenerationLockWaiters(t, ctx, cleanupBlocker, "ExclusiveLock", 1)
	if err = cleanupBlocker.Commit(ctx); err != nil {
		t.Fatalf("release cleanup blocker: %v", err)
	}

	purgedGenerations := 0
	var purgedRows int64
	for range 2 {
		result := <-cleanupResults
		if result.err != nil {
			t.Errorf("concurrent cleanup returned %v", result.err)
			continue
		}
		purgedGenerations += result.result.PurgedGenerationCount
		purgedRows += result.result.PurgedRowCount
	}
	if purgedGenerations != 1 || purgedRows == 0 {
		t.Fatalf("cleanup totals generations=%d rows=%d, want one non-empty generation", purgedGenerations, purgedRows)
	}
}

func TestUserSharedChangesFollowGenerationThatWinsLock(t *testing.T) {
	store := openSandboxLifecycleStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()

	actor, _ := seedSandboxLifecyclePrincipal(t, ctx, store)
	current, err := store.EnsureSandbox(ctx, domain.InitialTenantID())
	if err != nil {
		t.Fatalf("activate Sandbox: %v", err)
	}
	updatedActor, _ := seedSandboxLifecyclePrincipalWithToken(t, ctx, store, integrationBytes(121))
	deletedActor, _ := seedSandboxLifecyclePrincipalWithToken(t, ctx, store, integrationBytes(122))
	manager, err := store.CreateAccountSession(ctx, actor.UserID, integrationBytes(123))
	if err != nil {
		t.Fatal(err)
	}
	updatedName := "Admin Updated After Reset"
	cases := []struct {
		name        string
		aggregateID string
		action      string
		run         func() error
	}{
		{
			name: "update", aggregateID: updatedActor.UserID.String(), action: "updated",
			run: func() error {
				_, updateErr := store.UpdateOwnProfile(ctx, updatedActor, updatedName)
				return updateErr
			},
		},
		{
			name: "deactivate global account", aggregateID: deletedActor.UserID.String(), action: "deleted",
			run: func() error {
				active := false
				_, updateErr := store.UpdateManagedUser(ctx, manager, deletedActor.UserID, domain.UpdateManagedUserInput{Active: &active})
				return updateErr
			},
		},
	}

	for _, testCase := range cases {
		generationLock := holdSandboxGenerationLock(t, ctx, store)
		result := make(chan error, 1)
		go func() { result <- testCase.run() }()
		waitForSandboxGenerationLockWaiters(t, ctx, generationLock, "ShareLock", 1)

		previous := current
		current = replaceSandboxGenerationUnderLock(t, ctx, generationLock, previous)
		if err = generationLock.Commit(ctx); err != nil {
			t.Fatalf("%s: commit competing reset: %v", testCase.name, err)
		}
		if mutationErr := <-result; mutationErr != nil {
			t.Fatalf("%s user after generation wait: %v", testCase.name, mutationErr)
		}
		assertSharedChangeDataSpaces(
			t,
			ctx,
			store,
			testCase.aggregateID,
			testCase.action,
			[]uuid.UUID{domain.LiveDataSpaceID(), current.ID},
		)
	}
}

// Every Sandbox data-plane mutation must re-read the generation after reset
// releases its exclusive advisory lock. ApplySyncMutation deliberately uses
// READ COMMITTED because PostgreSQL establishes a SERIALIZABLE snapshot before
// a waiting advisory-lock statement runs.
func TestMutationsWaitingBehindResetLockRejectRetiredGeneration(t *testing.T) {
	store := openSandboxLifecycleStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	productionActor, terminalID := seedSandboxLifecyclePrincipal(t, ctx, store)
	sandbox, err := store.EnsureSandbox(ctx, domain.InitialTenantID())
	if err != nil {
		t.Fatalf("activate Sandbox: %v", err)
	}
	sandboxTokenHash := integrationBytes(41)
	sandboxSessionID := uuid.New()
	if _, err = store.Pool.Exec(ctx, `
		INSERT INTO sessions (id, user_id, terminal_id, token_hash, data_space_id)
		VALUES ($1,$2,$3,$4,$5)`,
		sandboxSessionID,
		productionActor.UserID,
		terminalID,
		sandboxTokenHash,
		sandbox.ID,
	); err != nil {
		t.Fatalf("create Sandbox session: %v", err)
	}
	sandboxActor := productionActor
	sandboxActor.SessionID = sandboxSessionID
	sandboxActor.DataSpaceID = sandbox.ID
	sandboxActor.DataMode = domain.DataModeSandbox
	sandboxActor.SandboxGeneration = sandbox.Generation
	packages, err := store.ListPackages(ctx, sandbox.ID, false)
	if err != nil || len(packages) == 0 {
		t.Fatalf("list Sandbox packages: count=%d error=%v", len(packages), err)
	}

	resetLock, err := store.Pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin reset lock: %v", err)
	}
	defer resetLock.Rollback(ctx)
	if _, err = resetLock.Exec(
		ctx,
		`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
		sandboxGenerationLock+":"+domain.InitialTenantID().String(),
	); err != nil {
		t.Fatalf("hold reset lock: %v", err)
	}

	type mutationCase struct {
		name string
		run  func() error
	}
	identity := principalIdentity(sandboxActor)
	mutations := []mutationCase{
		{
			name: "package",
			run: func() error {
				_, mutationErr := store.CreatePackage(ctx, sandboxActor, domain.CreatePackageInput{
					Code: "RESET-RACE", Name: "Reset Race", UnitPrice: 1_000,
				})
				return mutationErr
			},
		},
		{
			name: "transaction",
			run: func() error {
				_, mutationErr := store.CreateTransaction(ctx, domain.CreateTransactionInput{
					ID:            "01ARZ3NDEKTSV4RRFFQ69G5FAY",
					OccurredAt:    time.Now().UTC(),
					PaymentMethod: domain.PaymentMethodCash,
					Items: []domain.ItemInput{{
						PackageID: packages[0].ID, PackageRevision: 1, Quantity: 1,
					}},
					Identity: identity,
				})
				return mutationErr
			},
		},
		{
			name: "correction",
			run: func() error {
				_, mutationErr := store.CorrectTransaction(ctx, domain.CorrectTransactionInput{
					ID:            "01ARZ3NDEKTSV4RRFFQ69G5FB5",
					BaseRevision:  1,
					Reason:        "Pengujian koreksi menunggu reset",
					OccurredAt:    time.Now().UTC(),
					PaymentMethod: domain.PaymentMethodCash,
					Items: []domain.ItemInput{{
						PackageID: packages[0].ID, PackageRevision: 1, Quantity: 1,
					}},
					Identity: identity,
				})
				return mutationErr
			},
		},
		{
			name: "payment",
			run: func() error {
				_, mutationErr := store.SetTransactionPaymentStatus(ctx, domain.SetPaymentStatusInput{
					ID: "01ARZ3NDEKTSV4RRFFQ69G5FAZ", BaseRevision: 1,
					Status: domain.PaymentStatusSuccess, OccurredAt: time.Now().UTC(),
					Identity: identity,
				})
				return mutationErr
			},
		},
		{
			name: "print",
			run: func() error {
				_, mutationErr := store.RecordPrintAttempt(ctx, domain.PrintAttemptInput{
					ID: uuid.New(), TransactionID: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
					Revision: 1, Status: "success", PrinterKind: "simulator",
					OccurredAt: time.Now().UTC(), Identity: identity,
				})
				return mutationErr
			},
		},
		{
			name: "sync",
			run: func() error {
				_, _, mutationErr := store.ApplySyncMutation(
					ctx,
					sandboxActor,
					domain.SyncMutation{
						OperationID:     uuid.NewString(),
						Aggregate:       "unsupported",
						AggregateID:     "unsupported",
						Action:          "create",
						OriginSessionID: sandboxSessionID,
						OriginActorID:   sandboxActor.UserID,
						TerminalID:      terminalID,
						OccurredAt:      time.Now().UTC(),
					},
					integrationBytes(43),
				)
				return mutationErr
			},
		},
	}
	type mutationResult struct {
		name string
		err  error
	}
	results := make(chan mutationResult, len(mutations))
	for _, mutation := range mutations {
		go func() {
			results <- mutationResult{name: mutation.name, err: mutation.run()}
		}()
	}

	// Wait until every mutation is queued on this exact shared generation lock.
	// This proves each started before the retirement commit rather than merely
	// reading the already-retired row afterward.
	deadline := time.Now().Add(5 * time.Second)
	for {
		var waiting int
		if err = resetLock.QueryRow(ctx, `
			WITH lock_key AS (
				SELECT hashtextextended($1, 0) AS value
			)
			SELECT count(*)
			FROM pg_locks, lock_key
			WHERE locktype = 'advisory'
			  AND mode = 'ShareLock'
			  AND NOT granted
			  AND classid::bigint = ((value >> 32) & 4294967295)
			  AND objid::bigint = (value & 4294967295)
			  AND objsubid = 1`,
			sandboxGenerationLock+":"+domain.InitialTenantID().String(),
		).Scan(&waiting); err != nil {
			t.Fatalf("inspect waiting generation lock: %v", err)
		}
		if waiting >= len(mutations) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("only %d/%d mutations waited behind the reset lock", waiting, len(mutations))
		}
		time.Sleep(10 * time.Millisecond)
	}

	retiredAt := time.Now().UTC()
	if _, err = resetLock.Exec(ctx, `
		UPDATE data_spaces
		SET status = 'retired', retired_at = $2, purge_after = $3
		WHERE id = $1`,
		sandbox.ID,
		retiredAt,
		retiredAt.Add(30*24*time.Hour),
	); err != nil {
		t.Fatalf("retire Sandbox under reset lock: %v", err)
	}
	if err = resetLock.Commit(ctx); err != nil {
		t.Fatalf("commit Sandbox retirement: %v", err)
	}

	for range mutations {
		result := <-results
		if !domain.IsCode(result.err, domain.CodeSandboxGenerationRetired) {
			t.Errorf("waiting %s mutation returned %v", result.name, result.err)
		}
	}
	var leakedIdempotency int
	if err = store.Pool.QueryRow(ctx, `
		SELECT count(*) FROM idempotency_records WHERE data_space_id = $1`,
		sandbox.ID,
	).Scan(&leakedIdempotency); err != nil {
		t.Fatalf("count retired-generation idempotency rows: %v", err)
	}
	if leakedIdempotency != 0 {
		t.Fatalf("retired generation received %d idempotency rows", leakedIdempotency)
	}
}

func holdSandboxGenerationLock(t *testing.T, ctx context.Context, store *Store) pgx.Tx {
	t.Helper()
	tx, err := store.Pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin generation lock: %v", err)
	}
	if _, err = tx.Exec(
		ctx,
		`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
		sandboxGenerationLock+":"+domain.InitialTenantID().String(),
	); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("hold generation lock: %v", err)
	}
	return tx
}

func waitForSandboxGenerationLockWaiters(
	t *testing.T,
	ctx context.Context,
	query rowQuerier,
	mode string,
	want int,
) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		var waiting int
		if err := query.QueryRow(ctx, `
			WITH lock_key AS (
				SELECT hashtextextended($1, 0) AS value
			)
			SELECT count(*)
			FROM pg_locks, lock_key
			WHERE locktype = 'advisory'
			  AND mode = $2
			  AND NOT granted
			  AND classid::bigint = ((value >> 32) & 4294967295)
			  AND objid::bigint = (value & 4294967295)
			  AND objsubid = 1`,
			sandboxGenerationLock+":"+domain.InitialTenantID().String(),
			mode,
		).Scan(&waiting); err != nil {
			t.Fatalf("inspect waiting %s generation locks: %v", mode, err)
		}
		if waiting >= want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("only %d/%d %s generation locks were waiting", waiting, want, mode)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func replaceSandboxGenerationUnderLock(
	t *testing.T,
	ctx context.Context,
	tx pgx.Tx,
	previous domain.DataSpace,
) domain.DataSpace {
	t.Helper()
	now := time.Now().UTC().Truncate(time.Microsecond)
	purgeAfter := now.Add(30 * 24 * time.Hour)
	tag, err := tx.Exec(ctx, `
		UPDATE data_spaces
		SET status = 'retired', retired_at = $2, purge_after = $3
		WHERE id = $1 AND status = 'active'`,
		previous.ID,
		now,
		purgeAfter,
	)
	if err != nil {
		t.Fatalf("retire competing Sandbox generation: %v", err)
	}
	if tag.RowsAffected() != 1 {
		t.Fatalf("retired %d Sandbox generations, want 1", tag.RowsAffected())
	}
	replacement := domain.DataSpace{
		ID:          uuid.New(),
		Mode:        domain.DataModeSandbox,
		Generation:  previous.Generation + 1,
		Status:      domain.DataSpaceStatusActive,
		ActivatedAt: now,
	}
	if _, err = tx.Exec(ctx, `
		INSERT INTO data_spaces (id, mode, generation, status, activated_at,tenant_id)
		VALUES ($1, 'sandbox', $2, 'active', $3,$4)`,
		replacement.ID,
		replacement.Generation,
		replacement.ActivatedAt,
		domain.InitialTenantID(),
	); err != nil {
		t.Fatalf("insert competing Sandbox generation: %v", err)
	}
	return replacement
}

func assertSharedChangeDataSpaces(
	t *testing.T,
	ctx context.Context,
	store *Store,
	aggregateID string,
	action string,
	want []uuid.UUID,
) {
	t.Helper()
	rows, err := store.Pool.Query(ctx, `
		SELECT data_space_id
		FROM sync_changes
		WHERE aggregate = 'user' AND aggregate_id = $1 AND action = $2`,
		aggregateID,
		action,
	)
	if err != nil {
		t.Fatalf("list %s shared-change spaces: %v", action, err)
	}
	defer rows.Close()
	got := make(map[uuid.UUID]int)
	for rows.Next() {
		var dataSpaceID uuid.UUID
		if err = rows.Scan(&dataSpaceID); err != nil {
			t.Fatalf("scan %s shared-change space: %v", action, err)
		}
		got[dataSpaceID]++
	}
	if err = rows.Err(); err != nil {
		t.Fatalf("iterate %s shared-change spaces: %v", action, err)
	}
	if len(got) != len(want) {
		t.Fatalf("%s shared-change spaces = %v, want %v", action, got, want)
	}
	for _, dataSpaceID := range want {
		if got[dataSpaceID] != 1 {
			t.Fatalf("%s shared change count in %s = %d, want 1", action, dataSpaceID, got[dataSpaceID])
		}
	}
}

func assertInitialSandboxSeeds(
	t *testing.T,
	ctx context.Context,
	store *Store,
	dataSpaceID uuid.UUID,
	wantPackageChanges int,
) {
	t.Helper()
	for aggregate, want := range map[string]int{
		"package":  wantPackageChanges,
		"user":     1,
		"terminal": 1,
	} {
		var count int
		if err := store.Pool.QueryRow(ctx, `
			SELECT count(*) FROM sync_changes
			WHERE data_space_id = $1 AND aggregate = $2`, dataSpaceID, aggregate,
		).Scan(&count); err != nil {
			t.Fatalf("count initial %s sync changes: %v", aggregate, err)
		}
		if count != want {
			t.Fatalf("initial %s sync changes = %d, want %d", aggregate, count, want)
		}
	}
	var activationAuditCount int
	if err := store.Pool.QueryRow(ctx, `
		SELECT count(*) FROM audit_events
		WHERE data_space_id = $1 AND event_type = 'sandbox.activated'
		  AND aggregate_id = $2`, domain.LiveDataSpaceID(), dataSpaceID.String(),
	).Scan(&activationAuditCount); err != nil {
		t.Fatalf("count Sandbox activation audit: %v", err)
	}
	if activationAuditCount != 1 {
		t.Fatalf("Sandbox activation audit count = %d, want 1", activationAuditCount)
	}
}

func openSandboxLifecycleStore(t *testing.T) *Store {
	t.Helper()
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		t.Skip("DATABASE_URL is not configured")
	}
	base, err := gorm.Open(gormpostgres.Open(databaseURL), &gorm.Config{})
	if err != nil {
		t.Fatalf("open integration database: %v", err)
	}
	schemaName := "sandbox_lifecycle_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	quotedSchema := `"` + schemaName + `"`
	if err = base.Exec("CREATE SCHEMA " + quotedSchema).Error; err != nil {
		t.Fatalf("create lifecycle schema: %v", err)
	}

	parsedURL, err := url.Parse(databaseURL)
	if err != nil {
		t.Fatalf("parse DATABASE_URL: %v", err)
	}
	query := parsedURL.Query()
	query.Set("search_path", schemaName)
	parsedURL.RawQuery = query.Encode()
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	store, err := Open(ctx, parsedURL.String())
	if err != nil {
		_ = base.Exec("DROP SCHEMA " + quotedSchema + " CASCADE").Error
		t.Fatalf("open lifecycle store: %v", err)
	}
	if err = migrations.Apply(ctx, store.ORM); err != nil {
		store.Close()
		_ = base.Exec("DROP SCHEMA " + quotedSchema + " CASCADE").Error
		t.Fatalf("apply lifecycle migrations: %v", err)
	}
	t.Cleanup(func() {
		store.Close()
		if dropErr := base.Exec("DROP SCHEMA " + quotedSchema + " CASCADE").Error; dropErr != nil {
			t.Errorf("drop lifecycle schema: %v", dropErr)
		}
		if sqlDB, dbErr := base.DB(); dbErr == nil {
			_ = sqlDB.Close()
		}
	})
	return store
}

func seedSandboxLifecyclePrincipal(t *testing.T, ctx context.Context, store *Store) (domain.Principal, uuid.UUID) {
	t.Helper()
	return seedSandboxLifecyclePrincipalWithToken(t, ctx, store, integrationBytes(23))
}

func seedSandboxLifecyclePrincipalWithToken(
	t *testing.T,
	ctx context.Context,
	store *Store,
	tokenHash []byte,
) (domain.Principal, uuid.UUID) {
	t.Helper()
	userID := uuid.New()
	terminalID := uuid.New()
	sessionID := uuid.New()
	membershipID := uuid.New()
	if _, err := store.Pool.Exec(ctx, `
		INSERT INTO users (
			id, full_name, username, password_hash, role, is_active, must_change_password
		) VALUES ($1,'Sandbox Lifecycle Superadmin',$2,'hash','superadmin',true,false)`,
		userID, "sandbox_lifecycle_"+strings.ToLower(uuid.NewString()),
	); err != nil {
		t.Fatalf("insert lifecycle user: %v", err)
	}
	if _, err := store.Pool.Exec(ctx, `INSERT INTO tenant_memberships (id, tenant_id, user_id, role, status) VALUES ($1,$2,$3,'superadmin','active')`, membershipID, domain.InitialTenantID(), userID); err != nil {
		t.Fatalf("insert lifecycle membership: %v", err)
	}
	if _, err := store.Pool.Exec(ctx, `
		INSERT INTO terminals (
			id, installation_id, name, public_key, enrolled_by, tenant_id
		) VALUES ($1,$2,'Sandbox Lifecycle Terminal',$3,$4,$5)`,
		terminalID, uuid.NewString(), integrationBytes(17), userID, domain.InitialTenantID(),
	); err != nil {
		t.Fatalf("insert lifecycle terminal: %v", err)
	}
	if _, err := store.Pool.Exec(ctx, `
		INSERT INTO sessions (id, user_id, terminal_id, token_hash, data_space_id)
		VALUES ($1,$2,$3,$4,$5)`,
		sessionID, userID, terminalID, tokenHash, domain.LiveDataSpaceID(),
	); err != nil {
		t.Fatalf("insert lifecycle production session: %v", err)
	}
	return domain.Principal{
		Terminal: func() *domain.Terminal {
			terminal, err := store.GetTerminal(ctx, domain.InitialTenantID(), terminalID)
			if err != nil {
				t.Fatal(err)
			}
			return &terminal
		}(),
		ContextKind:  domain.ContextTenant,
		TenantID:     domain.InitialTenantID(),
		MembershipID: membershipID,
		UserID:       userID,
		SessionID:    sessionID,
		TerminalID:   &terminalID,
		FullName:     "Sandbox Lifecycle Superadmin",
		Username:     "sandbox_lifecycle",
		Role:         domain.RoleSuperadmin,
		DataSpaceID:  domain.LiveDataSpaceID(),
		DataMode:     domain.DataModeProduction,
	}, terminalID
}

func assertProductionPackageClones(t *testing.T, production, clones []domain.Package) {
	t.Helper()
	productionByID := make(map[uuid.UUID]domain.Package, len(production))
	for _, item := range production {
		productionByID[item.ID] = item
	}
	if len(clones) != len(production) {
		t.Fatalf("Sandbox clone count = %d, want %d", len(clones), len(production))
	}
	for _, clone := range clones {
		if clone.CurrentRevision != 1 || clone.SourcePackageID == nil || clone.SourceRevision == nil {
			t.Fatalf("Sandbox clone has invalid source shape: %+v", clone)
		}
		source, ok := productionByID[*clone.SourcePackageID]
		if !ok {
			t.Fatalf("Sandbox clone source %s is not an active production package", *clone.SourcePackageID)
		}
		if clone.ID == source.ID || *clone.SourceRevision != source.CurrentRevision ||
			clone.Code != source.Code || clone.Name != source.Name ||
			clone.Description != source.Description || clone.UnitPrice != source.UnitPrice {
			t.Fatalf("Sandbox clone %+v does not match production source %+v", clone, source)
		}
	}
}

func assertPurgeGuardRejectsOtherSpace(
	t *testing.T,
	ctx context.Context,
	store *Store,
	authorizedSpaceID uuid.UUID,
	targetSpaceID uuid.UUID,
) {
	t.Helper()
	tx, err := store.Pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin append-only protection check: %v", err)
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT set_config('app.sandbox_purge_data_space_id', $1, true)`, authorizedSpaceID.String()); err != nil {
		t.Fatalf("set append-only purge scope: %v", err)
	}
	_, err = tx.Exec(ctx, `
		DELETE FROM package_revisions
		WHERE data_space_id = $1`, targetSpaceID)
	if err == nil {
		t.Fatalf("purge scope %s deleted append-only rows from %s", authorizedSpaceID, targetSpaceID)
	}
	var postgresError *pgconn.PgError
	if !errors.As(err, &postgresError) || postgresError.Code != "55000" {
		t.Fatalf("append-only protection error = %v, want SQLSTATE 55000", err)
	}
}

func assertDataSpaceStatus(t *testing.T, ctx context.Context, store *Store, id uuid.UUID, want domain.DataSpaceStatus) {
	t.Helper()
	space, err := store.DataSpaceByID(ctx, domain.InitialTenantID(), id)
	if err != nil {
		t.Fatalf("read data space %s: %v", id, err)
	}
	if space.Status != want {
		t.Fatalf("data space %s status = %s, want %s", id, space.Status, want)
	}
}

func assertDataSpaceHasRows(t *testing.T, ctx context.Context, store *Store, id uuid.UUID) {
	t.Helper()
	var count int
	if err := store.Pool.QueryRow(ctx, `
		SELECT
			(SELECT count(*) FROM packages WHERE data_space_id = $1) +
			(SELECT count(*) FROM package_revisions WHERE data_space_id = $1) +
			(SELECT count(*) FROM sync_changes WHERE data_space_id = $1) +
			(SELECT count(*) FROM audit_events WHERE data_space_id = $1) +
			(SELECT count(*) FROM sessions WHERE data_space_id = $1)`, id,
	).Scan(&count); err != nil {
		t.Fatalf("count rows in data space %s: %v", id, err)
	}
	if count == 0 {
		t.Fatalf("data space %s unexpectedly has no rows", id)
	}
}

func assertDataSpaceIsEmpty(t *testing.T, ctx context.Context, store *Store, id uuid.UUID) {
	t.Helper()
	for _, table := range []string{
		"sessions", "packages", "package_revisions", "transactions",
		"transaction_revisions", "transaction_items", "print_attempts",
		"audit_events", "sync_changes", "idempotency_records",
	} {
		var count int
		query := fmt.Sprintf("SELECT count(*) FROM %s WHERE data_space_id = $1", table)
		if err := store.Pool.QueryRow(ctx, query, id).Scan(&count); err != nil {
			t.Fatalf("count %s in data space %s: %v", table, id, err)
		}
		if count != 0 {
			t.Fatalf("purged data space %s still has %d rows in %s", id, count, table)
		}
	}
}

func integrationBytes(value byte) []byte {
	result := make([]byte, 32)
	for index := range result {
		result[index] = value
	}
	return result
}
