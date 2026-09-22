// Package migrations applies ordered, forward-only GORM migrations.
package migrations

import (
	"context"
	"errors"
	"fmt"

	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/observability"
	"gorm.io/gorm"
)

const (
	initialMigrationVersion     = "000001_initial"
	paymentMigrationVersion     = "000002_transaction_payments"
	qrisBindingVersion          = "000003_qris_payload_binding"
	sandboxDataSpacesVersion    = "000004_sandbox_data_spaces"
	tenantsVersion              = "000005_tenants"
	internalOrganizationVersion = "000006_internal_organization"
	autoConfirmedPaymentVersion = "000007_payments_auto_confirmed"
	tenantSandboxSettingVersion = "000008_tenant_sandbox_setting"
)

type migration struct {
	version string
	up      func(context.Context, *gorm.DB) error
}

var orderedMigrations = []migration{
	{version: initialMigrationVersion, up: migrateInitialSchema},
	{version: paymentMigrationVersion, up: migrateTransactionPayments},
	{version: qrisBindingVersion, up: migrateQrisPayloadBinding},
	{version: sandboxDataSpacesVersion, up: migrateSandboxDataSpaces},
	{version: tenantsVersion, up: migrateTenants},
	{version: internalOrganizationVersion, up: migrateInternalOrganization},
	{version: autoConfirmedPaymentVersion, up: migratePaymentsAutoConfirmed},
	{version: tenantSandboxSettingVersion, up: migrateTenantSandboxSetting},
}

// Apply runs every pending migration through GORM in one PostgreSQL transaction.
// The advisory lock serializes startup migrations across application replicas.
func Apply(ctx context.Context, db *gorm.DB) error {
	defer observability.StartSegment(ctx, "Migrations.Apply")()

	if db == nil {
		err := errors.New("GORM database is required")
		observability.NoticeError(ctx, err, "apply GORM migrations")
		return err
	}

	err := db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Exec(
			`SELECT pg_advisory_xact_lock(hashtextextended('sewa-motor-schema-migrations', 0))`,
		).Error; err != nil {
			return fmt.Errorf("lock schema migrations: %w", err)
		}

		if err := tx.AutoMigrate(&schemaMigration{}); err != nil {
			return fmt.Errorf("migrate schema_migrations: %w", err)
		}

		for _, item := range orderedMigrations {
			var count int64
			if err := tx.Model(&schemaMigration{}).
				Where("version = ?", item.version).
				Count(&count).Error; err != nil {
				return fmt.Errorf("check migration %s: %w", item.version, err)
			}
			if count > 0 {
				continue
			}

			if err := item.up(ctx, tx); err != nil {
				return fmt.Errorf("apply migration %s: %w", item.version, err)
			}
			if err := tx.Create(&schemaMigration{Version: item.version}).Error; err != nil {
				return fmt.Errorf("record migration %s: %w", item.version, err)
			}
		}
		return nil
	})
	if err != nil {
		observability.NoticeError(ctx, err, "apply GORM migrations")
		return err
	}
	return nil
}
