package postgres

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/domain"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type missingPackageQuery struct{}

func (missingPackageQuery) QueryRow(context.Context, string, ...any) pgx.Row {
	return missingPackageRow{}
}

type missingPackageRow struct{}

func (missingPackageRow) Scan(...any) error { return pgx.ErrNoRows }

func TestResolveItemsReturnsNotFoundForPackageOutsideDataSpace(t *testing.T) {
	t.Parallel()

	_, _, err := resolveItems(
		context.Background(),
		missingPackageQuery{},
		uuid.New(),
		[]domain.ItemInput{{
			PackageID:       uuid.New(),
			PackageRevision: 1,
			Quantity:        1,
		}},
	)
	if !domain.IsCode(err, domain.CodeNotFound) {
		t.Fatalf("missing or out-of-scope package error = %v, want NOT_FOUND", err)
	}
}

// This test deliberately runs the same business workflow in Production and
// Sandbox. It proves that scoping is retained across transaction history,
// payment, printing, reporting, synchronization, audit, origin-session
// binding, and idempotency instead of testing those repositories in isolation.
// It uses the disposable-schema helper and is enabled by setting DATABASE_URL.
func TestSandboxDataPlaneIsolationMatrix(t *testing.T) {
	store := openSandboxLifecycleStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	productionActor, terminalID := seedSandboxLifecyclePrincipal(t, ctx, store)
	productionPackage, err := store.CreatePackage(ctx, productionActor, domain.CreatePackageInput{
		Code:         "ISOLATION",
		Name:         "Paket Isolasi",
		Description:  "Paket untuk matriks isolasi data",
		UnitPrice:    75_000,
		ChangeReason: "Pengujian isolasi Sandbox",
	})
	if err != nil {
		t.Fatalf("create production package: %v", err)
	}
	sandbox, err := store.EnsureSandbox(ctx, domain.InitialTenantID())
	if err != nil {
		t.Fatalf("activate Sandbox: %v", err)
	}
	sandboxPackages, err := store.ListPackages(ctx, sandbox.ID, false)
	if err != nil {
		t.Fatalf("list Sandbox packages: %v", err)
	}
	var sandboxPackage domain.Package
	for _, item := range sandboxPackages {
		if item.SourcePackageID != nil && *item.SourcePackageID == productionPackage.ID {
			sandboxPackage = item
			break
		}
	}
	if sandboxPackage.ID == uuid.Nil {
		t.Fatalf("production package %s was not cloned into Sandbox", productionPackage.ID)
	}

	sandboxActor, err := store.CreateSession(
		ctx,
		productionActor.UserID,
		productionActor.TerminalID,
		integrationBytes(29),
		sandbox.ID,
	)
	if err != nil {
		t.Fatalf("create Sandbox session: %v", err)
	}

	assertPackageNotFound(t, ctx, store, productionActor.DataSpaceID, sandboxPackage.ID)
	assertPackageNotFound(t, ctx, store, sandbox.ID, productionPackage.ID)
	if _, err = store.UpdatePackage(ctx, sandboxActor, productionPackage.ID, domain.UpdatePackageInput{
		Name: "Tidak boleh berubah", UnitPrice: 1, ChangeReason: "Lintas ruang",
	}); !domain.IsCode(err, domain.CodeNotFound) {
		t.Fatalf("Sandbox update of production package = %v, want NOT_FOUND", err)
	}
	if err = store.DeletePackage(ctx, productionActor, sandboxPackage.ID, "Lintas ruang"); !domain.IsCode(err, domain.CodeNotFound) {
		t.Fatalf("production delete of Sandbox package = %v, want NOT_FOUND", err)
	}
	sandboxPackage, err = store.UpdatePackage(ctx, sandboxActor, sandboxPackage.ID, domain.UpdatePackageInput{
		Name:         "Paket Isolasi Sandbox",
		Description:  "Perubahan ini tidak boleh masuk ke Produksi",
		UnitPrice:    80_000,
		ChangeReason: "Buktikan CRUD paket tetap terisolasi",
	})
	if err != nil {
		t.Fatalf("update cloned Sandbox package: %v", err)
	}
	unchangedProductionPackage, err := store.GetPackage(ctx, productionActor.DataSpaceID, productionPackage.ID)
	if err != nil {
		t.Fatalf("read production package after Sandbox update: %v", err)
	}
	if unchangedProductionPackage.Name != productionPackage.Name ||
		unchangedProductionPackage.UnitPrice != productionPackage.UnitPrice ||
		unchangedProductionPackage.CurrentRevision != productionPackage.CurrentRevision {
		t.Fatalf("Sandbox package update changed production source: before=%+v after=%+v",
			productionPackage, unchangedProductionPackage)
	}

	assertOriginSessionScope(t, ctx, store, productionActor, terminalID, productionActor.DataSpaceID, true)
	assertOriginSessionScope(t, ctx, store, productionActor, terminalID, sandbox.ID, false)
	assertOriginSessionScope(t, ctx, store, sandboxActor, terminalID, sandbox.ID, true)
	assertOriginSessionScope(t, ctx, store, sandboxActor, terminalID, productionActor.DataSpaceID, false)

	now := time.Now().UTC().Truncate(time.Microsecond)
	qrisHash := strings.Repeat("a", 64)
	if _, err := store.Pool.Exec(ctx, `INSERT INTO tenant_qris_revisions (tenant_id,revision,payload_hash,static_payload,created_by) VALUES ($1,1,$2,'fixture merchant payload',$3)`, productionActor.TenantID, qrisHash, productionActor.UserID); err != nil {
		t.Fatalf("seed merchant QRIS binding: %v", err)
	}
	productionID := "01ARZ3NDEKTSV4RRFFQ69G5FB1"
	sandboxID := "01ARZ3NDEKTSV4RRFFQ69G5FB2"

	for _, test := range []struct {
		name      string
		actor     domain.Principal
		id        string
		packageID uuid.UUID
		revision  int
	}{
		{
			name:      "Sandbox cannot consume production package",
			actor:     sandboxActor,
			id:        "01ARZ3NDEKTSV4RRFFQ69G5FB3",
			packageID: productionPackage.ID,
			revision:  productionPackage.CurrentRevision,
		},
		{
			name:      "Production cannot consume Sandbox package",
			actor:     productionActor,
			id:        "01ARZ3NDEKTSV4RRFFQ69G5FB4",
			packageID: sandboxPackage.ID,
			revision:  sandboxPackage.CurrentRevision,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, createErr := store.CreateTransaction(ctx, domain.CreateTransactionInput{
				ID:            test.id,
				OccurredAt:    now,
				PaymentMethod: domain.PaymentMethodCash,
				Items: []domain.ItemInput{{
					PackageID:       test.packageID,
					PackageRevision: test.revision,
					Quantity:        1,
				}},
				Identity: principalIdentity(test.actor),
			})
			if !domain.IsCode(createErr, domain.CodeNotFound) {
				t.Fatalf("cross-space package error = %v, want NOT_FOUND", createErr)
			}
		})
	}

	productionTransaction, err := store.CreateTransaction(ctx, domain.CreateTransactionInput{
		ID:            productionID,
		OccurredAt:    now,
		PaymentMethod: domain.PaymentMethodCash,
		Items: []domain.ItemInput{{
			PackageID:       productionPackage.ID,
			PackageRevision: productionPackage.CurrentRevision,
			Quantity:        1,
		}},
		Identity: principalIdentity(productionActor),
	})
	if err != nil {
		t.Fatalf("create production transaction: %v", err)
	}
	if productionTransaction.PaymentAmount != productionPackage.UnitPrice ||
		productionTransaction.DisplayID != "TRX-"+productionID {
		t.Fatalf("unexpected production transaction: %+v", productionTransaction)
	}

	sandboxTransaction, err := store.CreateTransaction(ctx, domain.CreateTransactionInput{
		ID:              sandboxID,
		OccurredAt:      now,
		PaymentMethod:   domain.PaymentMethodQRIS,
		QrisPayloadHash: &qrisHash,
		Items: []domain.ItemInput{{
			PackageID:       sandboxPackage.ID,
			PackageRevision: sandboxPackage.CurrentRevision,
			Quantity:        1,
		}},
		Identity: principalIdentity(sandboxActor),
	})
	if err != nil {
		t.Fatalf("create Sandbox transaction: %v", err)
	}
	if sandboxTransaction.PaymentAmount != domain.SandboxQRISPaymentAmount ||
		sandboxTransaction.DisplayID != "TEST-TRX-"+sandboxID {
		t.Fatalf("unexpected Sandbox transaction: %+v", sandboxTransaction)
	}

	assertTransactionNotFound(t, ctx, store, sandbox.ID, productionID)
	assertTransactionNotFound(t, ctx, store, productionActor.DataSpaceID, sandboxID)
	assertTransactionList(t, ctx, store, productionActor.DataSpaceID, productionID)
	assertTransactionList(t, ctx, store, sandbox.ID, sandboxID)
	assertCrossSpaceTransactionMutationsRejected(
		t,
		ctx,
		store,
		sandboxActor,
		productionActor.DataSpaceID,
		productionID,
		sandboxPackage,
		now.Add(100*time.Millisecond),
	)
	assertCrossSpaceTransactionMutationsRejected(
		t,
		ctx,
		store,
		productionActor,
		sandbox.ID,
		sandboxID,
		productionPackage,
		now.Add(200*time.Millisecond),
	)

	sandboxTransaction, err = store.CorrectTransaction(ctx, domain.CorrectTransactionInput{
		ID:              sandboxID,
		BaseRevision:    1,
		Reason:          "Uji revisi terisolasi",
		OccurredAt:      now.Add(time.Second),
		PaymentMethod:   domain.PaymentMethodQRIS,
		QrisPayloadHash: &qrisHash,
		Items: []domain.ItemInput{{
			PackageID:       sandboxPackage.ID,
			PackageRevision: sandboxPackage.CurrentRevision,
			Quantity:        2,
		}},
		Identity: principalIdentity(sandboxActor),
	})
	if err != nil {
		t.Fatalf("correct Sandbox transaction: %v", err)
	}
	if sandboxTransaction.Revision != 2 ||
		sandboxTransaction.Total != sandboxPackage.UnitPrice*2 ||
		sandboxTransaction.PaymentAmount != domain.SandboxQRISPaymentAmount {
		t.Fatalf("unexpected corrected Sandbox transaction: %+v", sandboxTransaction)
	}
	revisions, err := store.ListTransactionRevisions(ctx, sandbox.ID, sandboxID)
	if err != nil || len(revisions) != 1 || revisions[0].Revision != 2 ||
		revisions[0].DataSpaceID != sandbox.ID {
		t.Fatalf("Sandbox revisions = %+v, error=%v", revisions, err)
	}
	if _, err = store.ListTransactionRevisions(ctx, productionActor.DataSpaceID, sandboxID); !domain.IsCode(err, domain.CodeNotFound) {
		t.Fatalf("production history lookup for Sandbox transaction = %v, want NOT_FOUND", err)
	}

	productionTransaction = confirmPayment(t, ctx, store, productionActor, productionID, 1, now.Add(2*time.Second))
	sandboxTransaction = confirmPayment(t, ctx, store, sandboxActor, sandboxID, 2, now.Add(3*time.Second))
	if productionTransaction.PaymentAmount != productionPackage.UnitPrice ||
		sandboxTransaction.PaymentAmount != domain.SandboxQRISPaymentAmount {
		t.Fatalf("payment amounts changed after confirmation: production=%d Sandbox=%d",
			productionTransaction.PaymentAmount, sandboxTransaction.PaymentAmount)
	}

	productionPrintID := uuid.New()
	sandboxPrintID := uuid.New()
	recordSuccessfulPrint(t, ctx, store, productionActor, productionPrintID, productionID, 1, now.Add(4*time.Second))
	recordSuccessfulPrint(t, ctx, store, sandboxActor, sandboxPrintID, sandboxID, 2, now.Add(5*time.Second))
	assertPrintAttempts(t, ctx, store, productionActor.DataSpaceID, productionID, productionPrintID)
	assertPrintAttempts(t, ctx, store, sandbox.ID, sandboxID, sandboxPrintID)
	if _, err = store.ListPrintAttempts(ctx, productionActor.DataSpaceID, sandboxID); !domain.IsCode(err, domain.CodeNotFound) {
		t.Fatalf("production print lookup for Sandbox transaction = %v, want NOT_FOUND", err)
	}

	from, to := now.Add(-time.Minute), now.Add(time.Minute)
	productionDashboard, err := store.Dashboard(ctx, productionActor.DataSpaceID, from, to, "day")
	if err != nil {
		t.Fatalf("production dashboard: %v", err)
	}
	assertDashboard(t, productionDashboard, productionPackage.UnitPrice, 0)
	sandboxDashboard, err := store.Dashboard(ctx, sandbox.ID, from, to, "day")
	if err != nil {
		t.Fatalf("Sandbox dashboard: %v", err)
	}
	assertDashboard(t, sandboxDashboard, sandboxPackage.UnitPrice*2, domain.SandboxQRISPaymentAmount)

	productionRows, err := store.ExportRows(ctx, domain.TransactionFilter{
		From: &from, To: &to, DataSpaceID: productionActor.DataSpaceID,
	})
	if err != nil {
		t.Fatalf("production export rows: %v", err)
	}
	assertExportRows(t, productionRows, productionID, productionPackage.UnitPrice)
	sandboxRows, err := store.ExportRows(ctx, domain.TransactionFilter{
		From: &from, To: &to, DataSpaceID: sandbox.ID,
	})
	if err != nil {
		t.Fatalf("Sandbox export rows: %v", err)
	}
	assertExportRows(t, sandboxRows, sandboxID, domain.SandboxQRISPaymentAmount)

	assertSyncIsolation(t, ctx, store, productionActor.DataSpaceID, productionID, sandboxID, productionPrintID)
	assertSyncIsolation(t, ctx, store, sandbox.ID, sandboxID, productionID, sandboxPrintID)
	assertAuditIsolation(t, ctx, store, productionActor.DataSpaceID, productionID, sandboxID)
	assertAuditIsolation(t, ctx, store, sandbox.ID, sandboxID, productionID)

	operationID := uuid.NewString()
	productionOperation := unsupportedSyncOperation(productionActor, terminalID, operationID, now)
	sandboxOperation := unsupportedSyncOperation(sandboxActor, terminalID, operationID, now)
	productionHash := integrationBytes(101)
	sandboxHash := integrationBytes(102)
	if _, replayed, applyErr := store.ApplySyncMutation(ctx, productionActor, productionOperation, productionHash); replayed || !domain.IsCode(applyErr, domain.CodeValidation) {
		t.Fatalf("initial production idempotency result: replayed=%t error=%v", replayed, applyErr)
	}
	if _, replayed, applyErr := store.ApplySyncMutation(ctx, sandboxActor, sandboxOperation, sandboxHash); replayed || !domain.IsCode(applyErr, domain.CodeValidation) {
		t.Fatalf("initial Sandbox idempotency result: replayed=%t error=%v", replayed, applyErr)
	}
	if _, replayed, applyErr := store.ApplySyncMutation(ctx, productionActor, productionOperation, productionHash); !replayed || !domain.IsCode(applyErr, domain.CodeValidation) {
		t.Fatalf("production idempotency replay: replayed=%t error=%v", replayed, applyErr)
	}
	for _, dataSpaceID := range []uuid.UUID{productionActor.DataSpaceID, sandbox.ID} {
		var count int
		if err = store.Pool.QueryRow(ctx, `
			SELECT count(*) FROM idempotency_records
			WHERE data_space_id = $1 AND terminal_id = $2 AND operation_id = $3`,
			dataSpaceID, terminalID, operationID,
		).Scan(&count); err != nil || count != 1 {
			t.Fatalf("idempotency count for %s = %d, error=%v", dataSpaceID, count, err)
		}
	}
}

func assertOriginSessionScope(
	t *testing.T,
	ctx context.Context,
	store *Store,
	actor domain.Principal,
	terminalID uuid.UUID,
	dataSpaceID uuid.UUID,
	want bool,
) {
	t.Helper()
	got, err := store.OriginSessionMatches(ctx, actor.SessionID, actor.UserID, terminalID, dataSpaceID)
	if err != nil || got != want {
		t.Fatalf("origin session %s in %s = %t, want %t, error=%v",
			actor.SessionID, dataSpaceID, got, want, err)
	}
}

func assertTransactionNotFound(t *testing.T, ctx context.Context, store *Store, dataSpaceID uuid.UUID, id string) {
	t.Helper()
	if _, err := store.GetTransaction(ctx, dataSpaceID, id, true); !domain.IsCode(err, domain.CodeNotFound) {
		t.Fatalf("transaction %s in %s = %v, want NOT_FOUND", id, dataSpaceID, err)
	}
}

func assertPackageNotFound(
	t *testing.T,
	ctx context.Context,
	store *Store,
	dataSpaceID uuid.UUID,
	id uuid.UUID,
) {
	t.Helper()
	if _, err := store.GetPackage(ctx, dataSpaceID, id); !domain.IsCode(err, domain.CodeNotFound) {
		t.Fatalf("package %s in %s = %v, want NOT_FOUND", id, dataSpaceID, err)
	}
}

func assertTransactionList(t *testing.T, ctx context.Context, store *Store, dataSpaceID uuid.UUID, wantID string) {
	t.Helper()
	page, err := store.ListTransactions(ctx, domain.TransactionFilter{DataSpaceID: dataSpaceID, Limit: 100})
	if err != nil {
		t.Fatalf("list transactions in %s: %v", dataSpaceID, err)
	}
	if len(page.Transactions) != 1 || page.Transactions[0].ID != wantID ||
		page.Transactions[0].DataSpaceID != dataSpaceID {
		t.Fatalf("transactions in %s = %+v, want only %s", dataSpaceID, page.Transactions, wantID)
	}
}

func assertCrossSpaceTransactionMutationsRejected(
	t *testing.T,
	ctx context.Context,
	store *Store,
	attacker domain.Principal,
	targetDataSpaceID uuid.UUID,
	targetTransactionID string,
	attackerPackage domain.Package,
	occurredAt time.Time,
) {
	t.Helper()
	if _, err := store.CorrectTransaction(ctx, domain.CorrectTransactionInput{
		ID:            targetTransactionID,
		BaseRevision:  1,
		Reason:        "Percobaan koreksi lintas ruang",
		OccurredAt:    occurredAt,
		PaymentMethod: domain.PaymentMethodCash,
		Items: []domain.ItemInput{{
			PackageID:       attackerPackage.ID,
			PackageRevision: attackerPackage.CurrentRevision,
			Quantity:        1,
		}},
		Identity: principalIdentity(attacker),
	}); !domain.IsCode(err, domain.CodeNotFound) {
		t.Fatalf("cross-space correction of %s = %v, want NOT_FOUND", targetTransactionID, err)
	}
	if _, err := store.SetTransactionPaymentStatus(ctx, domain.SetPaymentStatusInput{
		ID: targetTransactionID, BaseRevision: 1, Status: domain.PaymentStatusSuccess,
		OccurredAt: occurredAt, Identity: principalIdentity(attacker),
	}); !domain.IsCode(err, domain.CodeNotFound) {
		t.Fatalf("cross-space payment of %s = %v, want NOT_FOUND", targetTransactionID, err)
	}
	if _, err := store.RecordPrintAttempt(ctx, domain.PrintAttemptInput{
		ID: uuid.New(), TransactionID: targetTransactionID, Revision: 1,
		Status: "success", PrinterKind: "simulator", Metadata: json.RawMessage(`{"test":true}`),
		OccurredAt: occurredAt, Identity: principalIdentity(attacker),
	}); !domain.IsCode(err, domain.CodeNotFound) {
		t.Fatalf("cross-space print of %s = %v, want NOT_FOUND", targetTransactionID, err)
	}

	unchanged, err := store.GetTransaction(ctx, targetDataSpaceID, targetTransactionID, true)
	if err != nil {
		t.Fatalf("read transaction %s after cross-space mutations: %v", targetTransactionID, err)
	}
	if unchanged.Revision != 1 || unchanged.PaymentStatus != domain.PaymentStatusSuccess ||
		unchanged.PaymentConfirmedRevision == nil || *unchanged.PaymentConfirmedRevision != unchanged.Revision {
		t.Fatalf("cross-space mutation changed transaction %s: %+v", targetTransactionID, unchanged)
	}
	attempts, err := store.ListPrintAttempts(ctx, targetDataSpaceID, targetTransactionID)
	if err != nil || len(attempts) != 0 {
		t.Fatalf("cross-space print changed attempts for %s: %+v, error=%v", targetTransactionID, attempts, err)
	}
}

func confirmPayment(
	t *testing.T,
	ctx context.Context,
	store *Store,
	actor domain.Principal,
	id string,
	revision int,
	occurredAt time.Time,
) domain.Transaction {
	t.Helper()
	transaction, err := store.SetTransactionPaymentStatus(ctx, domain.SetPaymentStatusInput{
		ID: id, BaseRevision: revision, Status: domain.PaymentStatusSuccess,
		OccurredAt: occurredAt, Identity: principalIdentity(actor),
	})
	if err != nil {
		t.Fatalf("confirm payment for %s: %v", id, err)
	}
	if transaction.PaymentStatus != domain.PaymentStatusSuccess ||
		transaction.PaymentConfirmedRevision == nil ||
		*transaction.PaymentConfirmedRevision != revision {
		t.Fatalf("unexpected confirmed payment for %s: %+v", id, transaction)
	}
	return transaction
}

func recordSuccessfulPrint(
	t *testing.T,
	ctx context.Context,
	store *Store,
	actor domain.Principal,
	attemptID uuid.UUID,
	transactionID string,
	revision int,
	occurredAt time.Time,
) {
	t.Helper()
	attempt, err := store.RecordPrintAttempt(ctx, domain.PrintAttemptInput{
		ID: attemptID, TransactionID: transactionID, Revision: revision,
		Status: "success", PrinterKind: "simulator", Metadata: json.RawMessage(`{"test":true}`),
		OccurredAt: occurredAt, Identity: principalIdentity(actor),
	})
	if err != nil {
		t.Fatalf("record print attempt for %s: %v", transactionID, err)
	}
	if attempt.ID != attemptID || attempt.DataSpaceID != actor.DataSpaceID {
		t.Fatalf("unexpected print attempt: %+v", attempt)
	}
}

func assertPrintAttempts(
	t *testing.T,
	ctx context.Context,
	store *Store,
	dataSpaceID uuid.UUID,
	transactionID string,
	wantID uuid.UUID,
) {
	t.Helper()
	attempts, err := store.ListPrintAttempts(ctx, dataSpaceID, transactionID)
	if err != nil || len(attempts) != 1 || attempts[0].ID != wantID ||
		attempts[0].DataSpaceID != dataSpaceID {
		t.Fatalf("print attempts for %s in %s = %+v, error=%v", transactionID, dataSpaceID, attempts, err)
	}
}

func assertDashboard(t *testing.T, dashboard domain.Dashboard, gross, actualQris int64) {
	t.Helper()
	if dashboard.GrossRevenue != gross || dashboard.ActualQrisAmount != actualQris ||
		dashboard.TransactionCount != 1 || len(dashboard.RecentTransactions) != 1 {
		t.Fatalf("dashboard = %+v, want gross=%d actualQris=%d count=1", dashboard, gross, actualQris)
	}
}

func assertExportRows(t *testing.T, rows []domain.ExportRow, transactionID string, paymentAmount int64) {
	t.Helper()
	if len(rows) != 1 || rows[0].TransactionID != transactionID || rows[0].PaymentAmount != paymentAmount {
		t.Fatalf("export rows = %+v, want transaction=%s paymentAmount=%d", rows, transactionID, paymentAmount)
	}
}

func assertSyncIsolation(
	t *testing.T,
	ctx context.Context,
	store *Store,
	dataSpaceID uuid.UUID,
	wantTransactionID string,
	forbiddenTransactionID string,
	wantPrintID uuid.UUID,
) {
	t.Helper()
	changes, err := store.PullChanges(ctx, dataSpaceID, 0, 10_000)
	if err != nil {
		t.Fatalf("pull changes for %s: %v", dataSpaceID, err)
	}
	foundTransaction := false
	foundPrint := false
	for _, change := range changes {
		if change.DataSpaceID != dataSpaceID {
			t.Fatalf("change from %s leaked into %s: %+v", change.DataSpaceID, dataSpaceID, change)
		}
		if change.Aggregate == "transaction" && change.AggregateID == forbiddenTransactionID {
			t.Fatalf("transaction %s leaked into sync space %s", forbiddenTransactionID, dataSpaceID)
		}
		if change.Aggregate == "transaction" && change.AggregateID == wantTransactionID {
			foundTransaction = true
		}
		if change.Aggregate == "print_attempt" && change.AggregateID == wantPrintID.String() {
			foundPrint = true
		}
	}
	if !foundTransaction || !foundPrint {
		t.Fatalf("sync changes for %s missing transaction=%t print=%t", dataSpaceID, foundTransaction, foundPrint)
	}
}

func assertAuditIsolation(
	t *testing.T,
	ctx context.Context,
	store *Store,
	dataSpaceID uuid.UUID,
	wantTransactionID string,
	forbiddenTransactionID string,
) {
	t.Helper()
	var ownCount, leakedCount int
	if err := store.Pool.QueryRow(ctx, `
		SELECT count(*) FROM audit_events
		WHERE data_space_id = $1 AND aggregate_type = 'transaction' AND aggregate_id = $2`,
		dataSpaceID, wantTransactionID,
	).Scan(&ownCount); err != nil {
		t.Fatalf("count own audit events in %s: %v", dataSpaceID, err)
	}
	if err := store.Pool.QueryRow(ctx, `
		SELECT count(*) FROM audit_events
		WHERE data_space_id = $1 AND aggregate_type = 'transaction' AND aggregate_id = $2`,
		dataSpaceID, forbiddenTransactionID,
	).Scan(&leakedCount); err != nil {
		t.Fatalf("count leaked audit events in %s: %v", dataSpaceID, err)
	}
	if ownCount == 0 || leakedCount != 0 {
		t.Fatalf("audit isolation in %s: own=%d leaked=%d", dataSpaceID, ownCount, leakedCount)
	}
}

func unsupportedSyncOperation(
	actor domain.Principal,
	terminalID uuid.UUID,
	operationID string,
	occurredAt time.Time,
) domain.SyncMutation {
	return domain.SyncMutation{
		OperationID: operationID, Aggregate: "unsupported", Action: "create",
		AggregateID: uuid.NewString(), OriginSessionID: actor.SessionID,
		OriginActorID: actor.UserID, TerminalID: terminalID, OccurredAt: occurredAt,
		Payload: json.RawMessage(`{}`),
	}
}
