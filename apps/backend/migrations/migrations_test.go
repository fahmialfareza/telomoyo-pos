package migrations

import (
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"sync"
	"testing"

	gormpostgres "gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/schema"
)

func TestMigrationPlanIsOrderedAndCompatible(t *testing.T) {
	t.Parallel()

	if len(orderedMigrations) == 0 {
		t.Fatal("migration plan is empty")
	}
	if orderedMigrations[0].version != "000001_initial" {
		t.Fatalf("first migration version = %q, want legacy-compatible 000001_initial", orderedMigrations[0].version)
	}
	if len(orderedMigrations) < 2 || orderedMigrations[1].version != "000002_transaction_payments" {
		t.Fatalf("payment migration is missing or out of order: %+v", orderedMigrations)
	}
	if len(orderedMigrations) < 3 || orderedMigrations[2].version != "000003_qris_payload_binding" {
		t.Fatalf("QRIS payload binding migration is missing or out of order: %+v", orderedMigrations)
	}
	if len(orderedMigrations) < 4 || orderedMigrations[3].version != "000004_sandbox_data_spaces" {
		t.Fatalf("Sandbox data-space migration is missing or out of order: %+v", orderedMigrations)
	}

	seen := make(map[string]struct{}, len(orderedMigrations))
	previous := ""
	for _, item := range orderedMigrations {
		if item.version <= previous {
			t.Fatalf("migration %q is not ordered after %q", item.version, previous)
		}
		if _, exists := seen[item.version]; exists {
			t.Fatalf("duplicate migration version %q", item.version)
		}
		if item.up == nil {
			t.Fatalf("migration %q has no up function", item.version)
		}
		seen[item.version] = struct{}{}
		previous = item.version
	}
}

func TestQrisPayloadBindingMigrationIsSeparatedFromPriorModels(t *testing.T) {
	t.Parallel()

	for name, model := range map[string]any{
		"000001": &transactionModel{},
		"000002": &transactionPaymentModel{},
	} {
		parsed, err := schema.Parse(model, &sync.Map{}, schema.NamingStrategy{})
		if err != nil {
			t.Fatal(err)
		}
		if parsed.LookUpField("QrisPayloadHash") != nil {
			t.Fatalf("%s model unexpectedly contains QrisPayloadHash", name)
		}
	}

	transaction, err := schema.Parse(
		&qrisPayloadBindingTransactionModel{},
		&sync.Map{},
		schema.NamingStrategy{},
	)
	if err != nil {
		t.Fatal(err)
	}
	if transaction.LookUpField("QrisPayloadHash") == nil {
		t.Fatal("000003 transaction model is missing QrisPayloadHash")
	}
	if _, ok := transaction.ParseCheckConstraints()["transactions_qris_payload_hash_shape"]; !ok {
		t.Fatal("000003 transaction QRIS binding constraint is missing")
	}

	revision, err := schema.Parse(
		&qrisPayloadBindingRevisionModel{},
		&sync.Map{},
		schema.NamingStrategy{},
	)
	if err != nil {
		t.Fatal(err)
	}
	if revision.LookUpField("QrisPayloadHash") == nil {
		t.Fatal("000003 revision model is missing QrisPayloadHash")
	}
	if _, ok := revision.ParseCheckConstraints()["transaction_revisions_qris_payload_hash_shape"]; !ok {
		t.Fatal("000003 revision QRIS binding constraint is missing")
	}
}

func TestPaymentMigrationIsSeparatedFromInitialModel(t *testing.T) {
	t.Parallel()

	cache := &sync.Map{}
	initial, err := schema.Parse(&transactionModel{}, cache, schema.NamingStrategy{})
	if err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"PaymentMethod", "PaymentStatus", "PaymentConfirmedRevision"} {
		if initial.LookUpField(field) != nil {
			t.Fatalf("000001 transaction model unexpectedly contains %s", field)
		}
	}

	payment, err := schema.Parse(
		&transactionPaymentModel{},
		&sync.Map{},
		schema.NamingStrategy{},
	)
	if err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"PaymentMethod", "PaymentStatus", "PaymentConfirmedRevision"} {
		if payment.LookUpField(field) == nil {
			t.Fatalf("000002 payment model is missing %s", field)
		}
	}
	checks := payment.ParseCheckConstraints()
	for _, name := range []string{
		"transactions_payment_method_allowed",
		"transactions_payment_status_allowed",
		"transactions_payment_confirmation_shape",
	} {
		if _, ok := checks[name]; !ok {
			t.Fatalf("000002 payment constraint %s is missing", name)
		}
	}
	indexes := payment.ParseIndexes()
	foundPaidIndex := false
	for _, item := range indexes {
		if item.Name == "transactions_paid_occurred_idx" {
			foundPaidIndex = item.Where ==
				"deleted_at IS NULL AND payment_status = 'success'"
		}
	}
	if !foundPaidIndex {
		t.Fatal("successful payment reporting index is missing")
	}
}

func TestMigrationTablesMatchSQLCSnapshotTables(t *testing.T) {
	t.Parallel()

	// The immutable 000001 models still describe their original migration.
	// Later migrations add tables with raw SQL: data_spaces in 000004 and the
	// tenancy tables in 000005. Include them when comparing against sqlc's
	// current-schema snapshot.
	migrationTables := append(modelTableNames(t),
		"data_spaces",
		"platform_audit_events", "tenant_invitations", "tenant_memberships",
		"tenant_profile_revisions", "tenant_qris_revisions", "tenants",
	)
	sort.Strings(migrationTables)
	snapshotPath := filepath.Join("..", "sqlc", "schema.sql")
	body, err := os.ReadFile(snapshotPath)
	if err != nil {
		t.Fatalf("read sqlc schema snapshot: %v", err)
	}
	matches := regexp.MustCompile(`(?m)^CREATE TABLE ([a-z_]+) \(`).FindAllSubmatch(body, -1)
	snapshotTables := make([]string, 0, len(matches))
	for _, match := range matches {
		snapshotTables = append(snapshotTables, string(match[1]))
	}
	sort.Strings(snapshotTables)

	if !reflect.DeepEqual(migrationTables, snapshotTables) {
		t.Fatalf("migration tables and sqlc snapshot differ\nmigrations: %v\nsqlc: %v", migrationTables, snapshotTables)
	}
	if files, err := filepath.Glob("*.up.sql"); err != nil {
		t.Fatalf("list runtime SQL migrations: %v", err)
	} else if len(files) != 0 {
		t.Fatalf("runtime SQL migrations remain: %v", files)
	}
}

func TestSQLCSnapshotPreservesSandboxLifecycleInvariants(t *testing.T) {
	t.Parallel()

	body, err := os.ReadFile(filepath.Join("..", "sqlc", "schema.sql"))
	if err != nil {
		t.Fatalf("read sqlc schema snapshot: %v", err)
	}
	snapshot := string(body)
	for _, required := range []string{
		"CONSTRAINT data_spaces_lifecycle_shape CHECK",
		"CREATE INDEX packages_data_space_live_idx",
		"current_setting('app.sandbox_purge_data_space_id', true)",
		"(to_jsonb(OLD) ->> 'data_space_id') = purge_space",
		"status = 'retired' AND purge_after <= now()",
	} {
		if !strings.Contains(snapshot, required) {
			t.Errorf("sqlc schema snapshot is missing Sandbox invariant %q", required)
		}
	}
}

func TestInitialModelsPreserveIndexesAndChecks(t *testing.T) {
	t.Parallel()

	type indexExpectation struct {
		class  string
		where  string
		fields []string
		sorts  []string
	}
	expected := map[string]indexExpectation{
		"users_username_key":                   {class: "UNIQUE", fields: []string{"username"}},
		"users_active_role_idx":                {where: "is_active AND deleted_at IS NULL", fields: []string{"role"}},
		"terminals_installation_id_key":        {class: "UNIQUE", fields: []string{"installation_id"}},
		"sessions_token_hash_key":              {class: "UNIQUE", fields: []string{"token_hash"}},
		"sessions_user_live_idx":               {where: "revoked_at IS NULL", fields: []string{"user_id"}},
		"packages_code_key":                    {class: "UNIQUE", fields: []string{"code"}},
		"transactions_occurred_idx":            {fields: []string{"occurred_at", "id"}, sorts: []string{"desc", "desc"}},
		"transactions_origin_actor_idx":        {fields: []string{"origin_actor_id", "occurred_at"}, sorts: []string{"", "desc"}},
		"transactions_live_idx":                {where: "deleted_at IS NULL", fields: []string{"occurred_at"}, sorts: []string{"desc"}},
		"transaction_items_current_filter_idx": {fields: []string{"package_id", "transaction_id", "revision"}},
		"print_attempts_transaction_idx":       {fields: []string{"transaction_id", "server_received_at"}, sorts: []string{"", "desc"}},
		"audit_events_aggregate_idx":           {fields: []string{"aggregate_type", "aggregate_id", "server_received_at"}, sorts: []string{"", "", "desc"}},
		"audit_events_actor_idx":               {fields: []string{"submitted_by_actor_id", "server_received_at"}, sorts: []string{"", "desc"}},
		"sync_changes_aggregate_idx":           {fields: []string{"aggregate", "aggregate_id", "cursor"}, sorts: []string{"", "", "desc"}},
	}

	found := make(map[string]indexExpectation, len(expected))
	checkNames := make(map[string]struct{})
	for _, parsed := range parseInitialModels(t) {
		for _, index := range parsed.ParseIndexes() {
			fields := make([]string, 0, len(index.Fields))
			sorts := make([]string, 0, len(index.Fields))
			hasSort := false
			for _, field := range index.Fields {
				fields = append(fields, field.DBName)
				sortDirection := strings.ToLower(field.Sort)
				sorts = append(sorts, sortDirection)
				hasSort = hasSort || sortDirection != ""
			}
			if !hasSort {
				sorts = nil
			}
			found[index.Name] = indexExpectation{
				class:  index.Class,
				where:  index.Where,
				fields: fields,
				sorts:  sorts,
			}
		}
		for name := range parsed.ParseCheckConstraints() {
			if _, exists := checkNames[name]; exists {
				t.Fatalf("duplicate check constraint %q", name)
			}
			checkNames[name] = struct{}{}
		}
	}

	if !reflect.DeepEqual(found, expected) {
		t.Fatalf("GORM index metadata differs\nfound: %#v\nwant:  %#v", found, expected)
	}
	if len(checkNames) != 40 {
		t.Fatalf("check constraint count = %d, want 40", len(checkNames))
	}
	for _, name := range []string{
		"users_username_format",
		"transactions_total_matches_subtotal",
		"transaction_revisions_shape",
		"transaction_items_line_total",
		"sync_changes_tombstone_action",
		"idempotency_records_request_hash_length",
	} {
		if _, exists := checkNames[name]; !exists {
			t.Errorf("critical check constraint %q is missing", name)
		}
	}
}

func TestPostgresSpecificInvariantsAreDeclared(t *testing.T) {
	t.Parallel()

	if len(initialForeignKeys) != 33 {
		t.Fatalf("foreign key count = %d, want 33", len(initialForeignKeys))
	}
	foreignKeyNames := make(map[string]struct{}, len(initialForeignKeys))
	deferred := make(map[string]bool)
	for _, spec := range initialForeignKeys {
		if _, exists := foreignKeyNames[spec.name]; exists {
			t.Fatalf("duplicate foreign key %q", spec.name)
		}
		foreignKeyNames[spec.name] = struct{}{}
		deferred[spec.name] = strings.Contains(spec.statement, "DEFERRABLE INITIALLY DEFERRED")
	}
	if !deferred["packages_current_revision_fk"] {
		t.Error("packages current revision foreign key is not deferred")
	}
	if !deferred["transactions_current_revision_fk"] {
		t.Error("transactions current revision foreign key is not deferred")
	}
	for name, isDeferred := range deferred {
		if name != "packages_current_revision_fk" &&
			name != "transactions_current_revision_fk" &&
			isDeferred {
			t.Errorf("unexpected deferred foreign key %q", name)
		}
	}

	wantAppendOnly := []string{
		"package_revisions",
		"transaction_revisions",
		"transaction_items",
		"print_attempts",
		"audit_events",
		"sync_changes",
		"idempotency_records",
	}
	if !reflect.DeepEqual(appendOnlyTables, wantAppendOnly) {
		t.Fatalf("append-only tables = %v, want %v", appendOnlyTables, wantAppendOnly)
	}
}

func TestSyncCursorUsesPostgresIdentity(t *testing.T) {
	t.Parallel()

	db, err := gorm.Open(gormpostgres.New(gormpostgres.Config{
		DSN: "postgres://gorm:gorm@localhost/gorm?sslmode=disable",
	}), &gorm.Config{
		DryRun:               true,
		DisableAutomaticPing: true,
	})
	if err != nil {
		t.Fatalf("open dry-run GORM database: %v", err)
	}

	statement := &gorm.Statement{DB: db}
	if err := statement.Parse(&syncChangeModel{}); err != nil {
		t.Fatalf("parse sync change model: %v", err)
	}
	cursor := statement.Schema.LookUpField("Cursor")
	if cursor == nil {
		t.Fatal("sync cursor field is missing")
	}
	dataType := db.Migrator().FullDataTypeOf(cursor).SQL
	if !strings.Contains(dataType, "bigint GENERATED ALWAYS AS IDENTITY") {
		t.Fatalf("sync cursor data type = %q, want PostgreSQL GENERATED ALWAYS identity", dataType)
	}
	if cursor.AutoIncrement {
		t.Fatal("sync cursor must not use GORM's bigserial auto-increment")
	}
}

func modelTableNames(t *testing.T) []string {
	t.Helper()

	parsed := parseInitialModels(t)
	tables := make([]string, 0, len(parsed))
	for _, model := range parsed {
		tables = append(tables, model.Table)
	}
	sort.Strings(tables)
	return tables
}

func parseInitialModels(t *testing.T) []*schema.Schema {
	t.Helper()

	cache := &sync.Map{}
	parsed := make([]*schema.Schema, 0, len(initialSchemaModels()))
	for _, model := range initialSchemaModels() {
		item, err := schema.Parse(model, cache, schema.NamingStrategy{})
		if err != nil {
			t.Fatalf("parse GORM model %T: %v", model, err)
		}
		parsed = append(parsed, item)
	}
	return parsed
}
