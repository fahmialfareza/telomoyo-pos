package postgres

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/adapter/security"
	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/bootstrap"
	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/domain"
	"github.com/google/uuid"
)

func initialSuperadminFixture() bootstrap.InitialSuperadminInput {
	return bootstrap.InitialSuperadminInput{
		Username: "initial.owner", FullName: "Initial Owner", TemporaryPassword: "fixture-temporary-password",
		Operator: "Fixture operator", Reason: "Initial production setup test",
	}
}

func TestInitialSuperadminCreatesOneForcedChangeAccountAndSafeGlobalProjections(t *testing.T) {
	store := openSandboxLifecycleStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	adminID := uuid.New()
	if _, err := store.Pool.Exec(ctx, `INSERT INTO users(id,username,full_name,password_hash,role,is_active,must_change_password)
	 VALUES($1,'existing.admin','Existing Admin','unchanged-fixture-hash','admin',true,false)`, adminID); err != nil {
		t.Fatal(err)
	}
	other := seedSecondTenantPrincipal(t, ctx, store, adminID, domain.RoleAdmin)
	if _, err := store.EnsureSandbox(ctx, other.TenantID); err != nil {
		t.Fatal(err)
	}
	input := initialSuperadminFixture()
	created, err := bootstrap.ApplyInitialSuperadmin(ctx, store.Pool, security.DefaultArgon2id(), input)
	if err != nil || !created {
		t.Fatalf("initial create=%v error=%v", created, err)
	}
	var id uuid.UUID
	var hash string
	var role domain.Role
	var active, forced bool
	if err = store.Pool.QueryRow(ctx, `SELECT id,password_hash,role,is_active,must_change_password FROM users WHERE username=$1`, input.Username).Scan(&id, &hash, &role, &active, &forced); err != nil {
		t.Fatal(err)
	}
	valid, err := security.DefaultArgon2id().Verify(input.TemporaryPassword, hash)
	if err != nil || !valid || role != domain.RoleSuperadmin || !active || !forced {
		t.Fatalf("created account settings invalid: role=%s active=%v forced=%v validCredential=%v err=%v", role, active, forced, valid, err)
	}
	var total, supers, links, activeSpaces, projectedSpaces int
	if err = store.Pool.QueryRow(ctx, `SELECT count(*),count(*) FILTER(WHERE role='superadmin') FROM users`).Scan(&total, &supers); err != nil || total != 2 || supers != 1 {
		t.Fatalf("bootstrap created unintended accounts: total=%d supers=%d err=%v", total, supers, err)
	}
	if err = store.Pool.QueryRow(ctx, `SELECT count(*) FROM tenant_memberships WHERE user_id=$1 AND tenant_id=$2`, id, domain.InitialTenantID()).Scan(&links); err != nil || links != 1 {
		t.Fatalf("missing initial attribution: %d %v", links, err)
	}
	var safe bool
	if err = store.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM data_spaces WHERE status='active'),count(DISTINCT data_space_id),
	 bool_and(payload->>'role'='superadmin' AND payload->>'tenantId'=tenant_id::text AND payload->>'mustChangePassword'='true'
	 AND NOT jsonb_exists(payload,'passwordHash') AND NOT jsonb_exists(payload,'password_hash') AND NOT jsonb_exists(payload,'temporaryPassword'))
	 FROM sync_changes WHERE aggregate='user' AND aggregate_id=$1`, id.String()).Scan(&activeSpaces, &projectedSpaces, &safe); err != nil {
		t.Fatal(err)
	}
	if activeSpaces != projectedSpaces || !safe {
		t.Fatalf("unsafe/incomplete projections: spaces=%d projections=%d safe=%v", activeSpaces, projectedSpaces, safe)
	}
	var audit json.RawMessage
	if err = store.Pool.QueryRow(ctx, `SELECT metadata FROM platform_audit_events WHERE event_type='account.initial_superadmin_bootstrapped' AND metadata->>'accountId'=$1`, id.String()).Scan(&audit); err != nil {
		t.Fatal(err)
	}
	var metadata map[string]any
	if err = json.Unmarshal(audit, &metadata); err != nil || metadata["operator"] != input.Operator || metadata["reason"] != input.Reason || metadata["source"] != "bootstrap-superadmin" || strings.Contains(string(audit), input.TemporaryPassword) || strings.Contains(string(audit), hash) {
		t.Fatal("bootstrap audit missing safe attribution or includes credentials")
	}
	// A retry must preserve a subsequently changed password requirement and all
	// credentials/session evidence, even if stdin contains a different password.
	if _, err = store.Pool.Exec(ctx, `UPDATE users SET must_change_password=false WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	session, err := store.CreateAccountSessionWithProtocol(ctx, id, integrationBytes(215), 3)
	if err != nil {
		t.Fatal(err)
	}
	before := snapshotInitialBootstrapState(t, ctx, store)
	input.TemporaryPassword = "different-fixture-password"
	if created, err = bootstrap.ApplyInitialSuperadmin(ctx, store.Pool, security.DefaultArgon2id(), input); err != nil || created {
		t.Fatalf("matching retry should be a no-op: created=%v err=%v", created, err)
	}
	if after := snapshotInitialBootstrapState(t, ctx, store); after != before {
		t.Fatal("retry modified existing accounts, sessions, projections, or audit")
	}
	if _, err = store.PrincipalBySession(ctx, session.SessionID, integrationBytes(215)); err != nil {
		t.Fatalf("idempotent retry revoked existing authorization: %v", err)
	}
}

func TestInitialSuperadminRefusesConflictingExistingAccountsWithoutMutation(t *testing.T) {
	for _, test := range []struct {
		name, username, fullName string
		role                     domain.Role
		active, deleted          bool
	}{
		{"active-admin", "initial.owner", "Initial Owner", domain.RoleAdmin, true, false},
		{"inactive-superadmin", "initial.owner", "Initial Owner", domain.RoleSuperadmin, false, false},
		{"deleted-superadmin", "initial.owner", "Initial Owner", domain.RoleSuperadmin, false, true},
		{"different-name", "initial.owner", "Another Owner", domain.RoleSuperadmin, true, false},
		{"other-active-superadmin", "other.owner", "Another Owner", domain.RoleSuperadmin, true, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			store := openSandboxLifecycleStore(t)
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			if _, err := store.Pool.Exec(ctx, `INSERT INTO users(username,full_name,password_hash,role,is_active,must_change_password,deleted_at)
			 VALUES($1,$2,'preserved-fixture-hash',$3,$4,false,CASE WHEN $5 THEN now() ELSE NULL END)`, test.username, test.fullName, test.role, test.active, test.deleted); err != nil {
				t.Fatal(err)
			}
			before := snapshotInitialBootstrapState(t, ctx, store)
			if created, err := bootstrap.ApplyInitialSuperadmin(ctx, store.Pool, security.DefaultArgon2id(), initialSuperadminFixture()); err == nil || created {
				t.Fatalf("unsafe existing account accepted: created=%v error=%v", created, err)
			}
			if after := snapshotInitialBootstrapState(t, ctx, store); before != after {
				t.Fatal("rejected bootstrap modified existing account evidence")
			}
		})
	}
}

func TestInitialSuperadminConcurrentFirstCreationCommitsOnlyOne(t *testing.T) {
	store := openSandboxLifecycleStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	start := make(chan struct{})
	var wait sync.WaitGroup
	created := make([]bool, 2)
	errors := make([]error, 2)
	for i := 0; i < 2; i++ {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			input := initialSuperadminFixture()
			if index == 1 {
				input.Username = "other.initial"
			}
			<-start
			created[index], errors[index] = bootstrap.ApplyInitialSuperadmin(ctx, store.Pool, security.DefaultArgon2id(), input)
		}(i)
	}
	close(start)
	wait.Wait()
	if created[0] == created[1] || (errors[0] == nil) == (errors[1] == nil) {
		t.Fatalf("concurrent bootstraps were not serialized: created=%v errors=%v", created, errors)
	}
	var users, events int
	if err := store.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM users),(SELECT count(*) FROM platform_audit_events WHERE event_type='account.initial_superadmin_bootstrapped')`).Scan(&users, &events); err != nil || users != 1 || events != 1 {
		t.Fatalf("concurrent bootstrap left extra rows: users=%d audit=%d err=%v", users, events, err)
	}
}

func TestInitialSuperadminRollsBackAccountAndProjectionsWhenAuditFails(t *testing.T) {
	store := openSandboxLifecycleStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if _, err := store.Pool.Exec(ctx, `CREATE FUNCTION reject_initial_superadmin_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
	 IF NEW.event_type='account.initial_superadmin_bootstrapped' THEN RAISE EXCEPTION 'fixture audit failure'; END IF; RETURN NEW; END $$;
	 CREATE TRIGGER reject_initial_superadmin_audit BEFORE INSERT ON platform_audit_events FOR EACH ROW EXECUTE FUNCTION reject_initial_superadmin_audit()`); err != nil {
		t.Fatal(err)
	}
	before := snapshotInitialBootstrapState(t, ctx, store)
	if created, err := bootstrap.ApplyInitialSuperadmin(ctx, store.Pool, security.DefaultArgon2id(), initialSuperadminFixture()); err == nil || created {
		t.Fatal("audit failure was allowed to commit")
	}
	if after := snapshotInitialBootstrapState(t, ctx, store); before != after {
		t.Fatal("audit failure left a partial account, membership, or sync projection")
	}
}

func snapshotInitialBootstrapState(t *testing.T, ctx context.Context, store *Store) string {
	t.Helper()
	var snapshot string
	if err := store.Pool.QueryRow(ctx, `SELECT jsonb_build_object(
	 'users',(SELECT jsonb_agg(to_jsonb(u) ORDER BY id) FROM users u),
	 'memberships',(SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM tenant_memberships m),
	 'sessions',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM sessions s),
	 'sync',(SELECT jsonb_agg(to_jsonb(c) ORDER BY cursor) FROM sync_changes c),
	 'audit',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM platform_audit_events a))::text`).Scan(&snapshot); err != nil {
		t.Fatal(err)
	}
	return snapshot
}
