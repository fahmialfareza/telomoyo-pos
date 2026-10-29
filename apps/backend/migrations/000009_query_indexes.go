package migrations

import (
	"context"
	"fmt"

	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/observability"
	"gorm.io/gorm"
)

// queryIndexNames lists every index created by migration 000009 so tests can
// assert on the same names the migration creates.
var queryIndexNames = []string{
	"transaction_revisions_data_space_idx",
	"transaction_items_data_space_idx",
	"print_attempts_data_space_idx",
	"package_revisions_data_space_idx",
	"sessions_data_space_idx",
	"transactions_origin_session_idx",
	"transaction_revisions_origin_session_idx",
	"transaction_revisions_submitted_session_idx",
	"print_attempts_session_idx",
	"audit_events_origin_session_idx",
	"audit_events_submitted_session_idx",
	"packages_source_package_idx",
	"sessions_terminal_live_idx",
	"transactions_data_space_paid_occurred_idx",
	"transactions_data_space_actor_occurred_idx",
	"platform_audit_events_created_idx",
}

// droppedQueryIndexNames are global transaction indexes superseded by the
// data-space-scoped ones above; every transaction query filters by data space.
var droppedQueryIndexNames = []string{
	"transactions_occurred_idx",
	"transactions_live_idx",
	"transactions_paid_occurred_idx",
	"transactions_origin_actor_idx",
}

// migrateQueryIndexes adds indexes for observed query paths. Migrations run in
// one transaction, so CONCURRENTLY is unavailable; builds briefly block writes.
func migrateQueryIndexes(ctx context.Context, tx *gorm.DB) error {
	defer observability.StartSegment(ctx, "Migrations.QueryIndexes")()
	statements := []string{
		// Sandbox purge deletes every scoped table by data_space_id.
		`CREATE INDEX transaction_revisions_data_space_idx ON transaction_revisions(data_space_id)`,
		`CREATE INDEX transaction_items_data_space_idx ON transaction_items(data_space_id)`,
		`CREATE INDEX print_attempts_data_space_idx ON print_attempts(data_space_id)`,
		`CREATE INDEX package_revisions_data_space_idx ON package_revisions(data_space_id)`,
		`CREATE INDEX sessions_data_space_idx ON sessions(data_space_id) WHERE data_space_id IS NOT NULL`,
		// Foreign-key checks fired when the purge deletes sessions and packages.
		`CREATE INDEX transactions_origin_session_idx ON transactions(origin_session_id)`,
		`CREATE INDEX transaction_revisions_origin_session_idx ON transaction_revisions(origin_session_id)`,
		`CREATE INDEX transaction_revisions_submitted_session_idx ON transaction_revisions(submitted_by_session_id)`,
		`CREATE INDEX print_attempts_session_idx ON print_attempts(session_id)`,
		`CREATE INDEX audit_events_origin_session_idx ON audit_events(origin_session_id) WHERE origin_session_id IS NOT NULL`,
		`CREATE INDEX audit_events_submitted_session_idx ON audit_events(submitted_by_session_id) WHERE submitted_by_session_id IS NOT NULL`,
		`CREATE INDEX packages_source_package_idx ON packages(source_package_id) WHERE source_package_id IS NOT NULL`,
		// Terminal revocation revokes live sessions by terminal.
		`CREATE INDEX sessions_terminal_live_idx ON sessions(terminal_id) WHERE revoked_at IS NULL`,
		// Dashboard totals become index-only scans within one data space.
		`CREATE INDEX transactions_data_space_paid_occurred_idx ON transactions(data_space_id,occurred_at)
		 INCLUDE (total,payment_amount,payment_method,current_revision,payment_confirmed_revision)
		 WHERE deleted_at IS NULL AND payment_status='success'`,
		// Transaction list filtered by creator with keyset pagination.
		`CREATE INDEX transactions_data_space_actor_occurred_idx ON transactions(data_space_id,origin_actor_id,occurred_at DESC,id DESC)`,
		`CREATE INDEX platform_audit_events_created_idx ON platform_audit_events(created_at DESC,id DESC)`,
	}
	for _, name := range droppedQueryIndexNames {
		statements = append(statements, `DROP INDEX IF EXISTS `+name)
	}
	for _, statement := range statements {
		if err := tx.WithContext(ctx).Exec(statement).Error; err != nil {
			return fmt.Errorf("create query index: %w", err)
		}
	}
	return nil
}
