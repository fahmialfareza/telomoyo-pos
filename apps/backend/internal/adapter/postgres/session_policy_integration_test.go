package postgres

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/adapter/security"
	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/domain"
	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/usecase"
	"github.com/google/uuid"
)

func TestSandboxPaymentAmountUsesImmutableOriginPolicyNotSubmittingSession(t *testing.T) {
	store := openSandboxLifecycleStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	production, _ := seedSandboxLifecyclePrincipal(t, ctx, store)
	publicKey, privateKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = store.Pool.Exec(ctx, `UPDATE terminals SET public_key=$1 WHERE id=$2`, []byte(publicKey), production.TerminalID); err != nil {
		t.Fatal(err)
	}
	space, err := store.EnsureSandbox(ctx, production.TenantID)
	if err != nil {
		t.Fatal(err)
	}
	legacy, err := store.SwitchSession(ctx, production, integrationBytes(23), integrationBytes(201), space.ID)
	if err != nil {
		t.Fatal(err)
	}
	if legacy.ProtocolVersion != 2 || legacy.EffectiveSandboxQRISPolicy() != domain.SandboxQRISPolicyFixed1000 {
		t.Fatalf("legacy mode exchange invented a new policy: %+v", legacy)
	}
	pack, err := store.CreatePackage(ctx, legacy, domain.CreatePackageInput{Code: "POLICY", Name: "Paket Uji Nominal", UnitPrice: 27_500, ChangeReason: "Uji kebijakan sesi"})
	if err != nil {
		t.Fatal(err)
	}
	qrisHash := strings.Repeat("c", 64)
	if _, err = store.Pool.Exec(ctx, `INSERT INTO tenant_qris_revisions(tenant_id,revision,payload_hash,static_payload,created_by) VALUES($1,1,$2,'immutable fixture merchant',$3)`, production.TenantID, qrisHash, production.UserID); err != nil {
		t.Fatal(err)
	}
	input := domain.CreateTransactionInput{ID: "01ARZ3NDEKTSV4RRFFQ69G5FP1", OccurredAt: time.Now().UTC(), PaymentMethod: domain.PaymentMethodQRIS,
		QrisPayloadHash: &qrisHash, Items: []domain.ItemInput{{PackageID: pack.ID, PackageRevision: 1, Quantity: 2}}, Identity: principalIdentity(legacy)}
	// The old queue was signed before upgrading. It contains neither an amount
	// nor a policy, so only the immutable origin session can resolve its payment.
	payload, err := json.Marshal(map[string]any{"id": input.ID, "paymentMethod": input.PaymentMethod, "qrisPayloadHash": qrisHash, "items": input.Items})
	if err != nil {
		t.Fatal(err)
	}
	queued := domain.SyncMutation{
		OperationID: uuid.NewString(), Aggregate: "transaction", AggregateID: input.ID, Action: "create",
		OriginSessionID: legacy.SessionID, OriginActorID: legacy.UserID, TerminalID: *legacy.TerminalID,
		OccurredAt: input.OccurredAt, Payload: payload,
	}
	canonical, err := security.CanonicalMutation(queued)
	if err != nil {
		t.Fatal(err)
	}
	queued.Signature = base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, canonical))
	beforeQueue, err := json.Marshal(queued)
	if err != nil {
		t.Fatal(err)
	}
	upgraded, err := store.UpgradeSession(ctx, legacy, integrationBytes(201), integrationBytes(202), 3)
	if err != nil {
		t.Fatal(err)
	}
	if upgraded.DataSpaceID != legacy.DataSpaceID || upgraded.TenantID != legacy.TenantID || upgraded.MembershipID != legacy.MembershipID ||
		upgraded.TerminalID == nil || *upgraded.TerminalID != *legacy.TerminalID || upgraded.SandboxGeneration != legacy.SandboxGeneration ||
		upgraded.ProtocolVersion != 3 || upgraded.SandboxQRISPolicy != domain.SandboxQRISPolicyTransactionTotal {
		t.Fatalf("upgrade changed scope or omitted policy: %+v", upgraded)
	}
	syncService := usecase.Sync{Repo: store}
	results, err := syncService.Push(ctx, upgraded, []domain.SyncMutation{queued})
	if err != nil || len(results) != 1 || results[0].Error != nil || results[0].Status != 201 || results[0].Replayed {
		t.Fatalf("submit signed legacy origin through upgraded session: %+v %v", results, err)
	}
	var oldTransaction domain.Transaction
	if err = json.Unmarshal(results[0].Data, &oldTransaction); err != nil {
		t.Fatal(err)
	}
	if oldTransaction.Total != 55_000 || oldTransaction.PaymentAmount != 1_000 {
		t.Fatalf("uploader's new policy reinterpreted old outbox: %+v", oldTransaction)
	}
	afterQueue, err := json.Marshal(queued)
	if err != nil || !bytes.Equal(beforeQueue, afterQueue) {
		t.Fatalf("synchronizing changed original signed queue bytes: %v", err)
	}
	replayed, err := syncService.Push(ctx, upgraded, []domain.SyncMutation{queued})
	if err != nil || len(replayed) != 1 || replayed[0].Error != nil || !replayed[0].Replayed {
		t.Fatalf("upgraded uploader did not replay exact legacy result: %+v %v", replayed, err)
	}
	var replayedTransaction domain.Transaction
	if err = json.Unmarshal(replayed[0].Data, &replayedTransaction); err != nil || !reflect.DeepEqual(oldTransaction, replayedTransaction) {
		t.Fatalf("JSONB replay changed legacy transaction content: %+v %v", replayedTransaction, err)
	}
	var requestHash []byte
	if err = store.Pool.QueryRow(ctx, `SELECT request_hash FROM idempotency_records WHERE data_space_id=$1 AND terminal_id=$2 AND operation_id=$3`, legacy.DataSpaceID, queued.TerminalID, queued.OperationID).Scan(&requestHash); err != nil {
		t.Fatal(err)
	}
	wantHash := sha256.Sum256(canonical)
	if !bytes.Equal(requestHash, wantHash[:]) {
		t.Fatal("idempotency hash no longer represents the original signed payload")
	}
	var persistedPolicy domain.SandboxQRISPolicy
	var revokedReason string
	if err = store.Pool.QueryRow(ctx, `SELECT sandbox_qris_policy,revoked_reason FROM sessions WHERE id=$1`, legacy.SessionID).Scan(&persistedPolicy, &revokedReason); err != nil {
		t.Fatal(err)
	}
	if persistedPolicy != domain.SandboxQRISPolicyFixed1000 || revokedReason != "session_upgraded" {
		t.Fatalf("old origin evidence mutated: policy=%s reason=%s", persistedPolicy, revokedReason)
	}
	input.ID, input.Identity = "01ARZ3NDEKTSV4RRFFQ69G5FP2", principalIdentity(upgraded)
	newTransaction, err := store.CreateTransaction(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	if newTransaction.PaymentAmount != 55_000 {
		t.Fatalf("new origin did not use total: %+v", newTransaction)
	}
	corrected, err := store.CorrectTransaction(ctx, domain.CorrectTransactionInput{ID: oldTransaction.ID, BaseRevision: 1, OccurredAt: input.OccurredAt,
		PaymentMethod: input.PaymentMethod, QrisPayloadHash: input.QrisPayloadHash, Items: input.Items, Reason: "Koreksi menggunakan nominal penuh", Identity: input.Identity})
	if err != nil {
		t.Fatal(err)
	}
	if corrected.PaymentAmount != 55_000 || corrected.PaymentStatus != domain.PaymentStatusSuccess ||
		corrected.PaymentConfirmedRevision == nil || *corrected.PaymentConfirmedRevision != corrected.Revision {
		t.Fatalf("correction did not adopt its own origin policy/confirm payment: %+v", corrected)
	}
	var historicAmount int64
	if err = store.Pool.QueryRow(ctx, `SELECT payment_amount FROM transaction_revisions WHERE transaction_id=$1 AND revision=1 AND data_space_id=$2`, oldTransaction.ID, space.ID).Scan(&historicAmount); err != nil {
		t.Fatal(err)
	}
	if historicAmount != 1_000 {
		t.Fatalf("history rewritten to %d", historicAmount)
	}
	for _, sql := range []string{`UPDATE sessions SET sandbox_qris_policy='transaction_total',protocol_version=3 WHERE id=$1`, `UPDATE sessions SET protocol_version=1 WHERE id=$1`} {
		if _, err = store.Pool.Exec(ctx, sql, legacy.SessionID); err == nil {
			t.Fatal("session policy/protocol changed in-place")
		}
	}
	if _, err = store.UpgradeSession(ctx, legacy, integrationBytes(201), integrationBytes(203), 3); !domain.IsCode(err, domain.CodeUnauthorized) && !domain.IsCode(err, domain.CodeForbidden) {
		t.Fatalf("old token upgraded twice: %v", err)
	}
	back, err := store.SwitchSession(ctx, upgraded, integrationBytes(202), integrationBytes(204), production.DataSpaceID)
	if err != nil {
		t.Fatal(err)
	}
	if back.ProtocolVersion != 3 || back.SandboxQRISPolicy != domain.SandboxQRISPolicyTransactionTotal {
		t.Fatal("mode switch discarded payment policy")
	}
	account, err := store.SwitchContextSession(ctx, back, integrationBytes(204), integrationBytes(205), domain.SwitchContextInput{Kind: domain.ContextAccount})
	if err != nil {
		t.Fatal(err)
	}
	if account.ProtocolVersion != 3 || account.SandboxQRISPolicy != domain.SandboxQRISPolicyTransactionTotal || account.IsTenantContext() {
		t.Fatal("context switch discarded policy or retained business authority")
	}
}

func TestCreateAccountSessionNegotiatesExplicitPaymentPolicy(t *testing.T) {
	store := openSandboxLifecycleStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	actor, _ := seedSandboxLifecyclePrincipal(t, ctx, store)
	for _, protocol := range []int{2, 3} {
		principal, err := store.CreateAccountSessionWithProtocol(ctx, actor.UserID, integrationBytes(byte(210+protocol)), protocol)
		if err != nil {
			t.Fatal(err)
		}
		if principal.ContextKind != domain.ContextAccount || principal.ProtocolVersion != protocol || principal.SandboxQRISPolicy != domain.SandboxQRISPolicyForProtocol(protocol) {
			t.Fatalf("negotiation mismatch: %+v", principal)
		}
	}
}
