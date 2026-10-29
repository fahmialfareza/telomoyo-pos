package postgres

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/domain"
	"github.com/google/uuid"
)

func TestSharedTenantAccessRetainsMerchantPermissionsAndRecovery(t *testing.T) {
	store := openSandboxLifecycleStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	legacy, _ := seedSandboxLifecyclePrincipal(t, ctx, store)
	// A Superadmin keeps organization management inside a business context.
	if _, err := store.ListTenants(ctx, legacy); err != nil {
		t.Fatalf("business-context Superadmin lost management access: %v", err)
	}
	if _, err := store.SwitchContextSession(ctx, legacy, integrationBytes(23), integrationBytes(129), domain.SwitchContextInput{Kind: domain.ContextPlatform}); !domain.IsCode(err, domain.CodeClientUpdateRequired) {
		t.Fatalf("issued retired platform context: %v", err)
	}
	manager, err := store.CreateAccountSessionWithProtocol(ctx, legacy.UserID, integrationBytes(130), 3)
	if err != nil {
		t.Fatal(err)
	}
	created, err := store.CreateTenant(ctx, manager, domain.CreateTenantInput{Name: "Shared Business", Slug: "shared-business"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if created.Tenant.Status != "active" || created.Invitation.ID != uuid.Nil {
		t.Fatalf("new tenant still requires invitation: %+v", created)
	}
	owner, err := store.SwitchContextSession(ctx, manager, integrationBytes(130), integrationBytes(131), domain.SwitchContextInput{Kind: domain.ContextTenant, TenantID: created.Tenant.ID})
	if err != nil {
		t.Fatalf("Superadmin without old membership cannot enter: %v", err)
	}
	profile, err := store.UpdateTenantProfile(ctx, owner, domain.UpdateTenantProfileInput{ExpectedRevision: 1, BusinessName: "Business Revision 2", Address: "Second address", Phone: "081234"})
	if err != nil || profile.Revision != 2 {
		t.Fatalf("profile revision: %+v %v", profile, err)
	}
	if _, err = store.UpdateTenantProfile(ctx, owner, domain.UpdateTenantProfileInput{ExpectedRevision: 1, BusinessName: "Stale"}); !domain.IsCode(err, domain.CodeRevisionConflict) {
		t.Fatalf("stale profile update: %v", err)
	}
	for revision := 0; revision < 2; revision++ {
		qris, e := store.UpdateTenantQRIS(ctx, owner, domain.UpdateTenantQRISInput{ExpectedRevision: revision, StaticPayload: "immutable-fixture"}, strings.Repeat("b", 64))
		if e != nil || qris.Revision != revision+1 || len(qris.Payloads) != revision+1 {
			t.Fatalf("QRIS historical version lost: %+v %v", qris, e)
		}
	}
	var userID uuid.UUID
	if err = store.Pool.QueryRow(ctx, `INSERT INTO users(full_name,username,password_hash,role,must_change_password) VALUES('Cashier','business.cashier','hash','admin',false) RETURNING id`).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	account, err := store.CreateAccountSessionWithProtocol(ctx, userID, integrationBytes(132), 3)
	if err != nil {
		t.Fatal(err)
	}
	staff, err := store.SwitchContextSession(ctx, account, integrationBytes(132), integrationBytes(133), domain.SwitchContextInput{Kind: domain.ContextTenant, TenantID: owner.TenantID})
	if err != nil || staff.Role != domain.RoleAdmin {
		t.Fatalf("Admin requires membership approval: %+v %v", staff, err)
	}
	if _, err = store.ListTenants(ctx, staff); !domain.IsCode(err, domain.CodeForbidden) {
		t.Fatalf("business-context Admin bypassed management barrier: %v", err)
	}
	if _, err = store.UpdateTenantProfile(ctx, staff, domain.UpdateTenantProfileInput{ExpectedRevision: 2, BusinessName: "Not permitted"}); !domain.IsCode(err, domain.CodeForbidden) {
		t.Fatalf("Admin changed receipt identity: %v", err)
	}
	if _, err = store.UpdateTenantQRIS(ctx, staff, domain.UpdateTenantQRISInput{ExpectedRevision: 2, StaticPayload: "other"}, strings.Repeat("c", 64)); !domain.IsCode(err, domain.CodeForbidden) {
		t.Fatalf("Admin changed merchant: %v", err)
	}
	manager, err = store.CreateAccountSessionWithProtocol(ctx, legacy.UserID, integrationBytes(134), 3)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = store.SetTenantStatus(ctx, manager, owner.TenantID, "suspended"); err != nil {
		t.Fatal(err)
	}
	blocked, err := store.PrincipalBySession(ctx, staff.SessionID, integrationBytes(133))
	if !domain.IsCode(err, domain.CodeTenantSuspended) {
		t.Fatalf("suspension discovery: %v", err)
	}
	if _, err = store.SetTenantStatus(ctx, manager, owner.TenantID, "active"); err != nil {
		t.Fatal(err)
	}
	if _, err = store.PrincipalBySession(ctx, staff.SessionID, integrationBytes(133)); err == nil {
		t.Fatal("reactivation revived old token")
	}
	if _, err = store.SwitchContextSession(ctx, blocked, integrationBytes(133), integrationBytes(135), domain.SwitchContextInput{Kind: domain.ContextTenant, TenantID: owner.TenantID}); err != nil {
		t.Fatalf("fresh authorized exchange after reactivation: %v", err)
	}
	if _, err = store.PrincipalBySession(ctx, legacy.SessionID, integrationBytes(23)); err != nil {
		t.Fatalf("suspension affected another tenant: %v", err)
	}
	audit, err := store.ListPlatformAudit(ctx, manager, 100)
	if err != nil || len(audit) < 6 {
		t.Fatalf("durable management audit: %d %v", len(audit), err)
	}
}

func TestSharedAccessNeverReleasesAnotherAccountsQuarantinedOrigins(t *testing.T) {
	store := openSandboxLifecycleStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	actor, _ := seedSandboxLifecyclePrincipal(t, ctx, store)
	other, _ := seedSandboxLifecyclePrincipalWithToken(t, ctx, store, integrationBytes(151))
	origins := []domain.OutboxOrigin{{OriginActorID: actor.UserID, OriginSessionID: actor.SessionID, TerminalID: *actor.TerminalID}, {OriginActorID: other.UserID, OriginSessionID: other.SessionID, TerminalID: *other.TerminalID}, {OriginActorID: actor.UserID, OriginSessionID: uuid.New(), TerminalID: *actor.TerminalID}}
	if _, err := store.Pool.Exec(ctx, `UPDATE tenant_memberships SET role='admin',status='inactive' WHERE id=$1`, actor.MembershipID); err != nil {
		t.Fatal(err)
	}
	validated, err := store.RevalidateOrigins(ctx, actor, origins)
	if err != nil {
		t.Fatal(err)
	}
	if len(validated) != 3 || !validated[0].Allowed || validated[1].Allowed || validated[2].Allowed {
		t.Fatalf("release crossed origin account/enrollment: %+v", validated)
	}
	if err = store.ChangeOwnPassword(ctx, actor, "new-hash"); err != nil {
		t.Fatal(err)
	}
	if _, err = store.CreateUser(ctx, actor, domain.CreateUserInput{}, "hash"); !domain.IsCode(err, domain.CodeClientUpdateRequired) {
		t.Fatalf("obsolete global mutation reachable: %v", err)
	}
}
