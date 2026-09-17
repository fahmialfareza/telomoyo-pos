package main

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/adapter/postgres"
	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/bootstrap"
	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/config"
	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/observability"
	"github.com/newrelic/go-agent/v3/newrelic"
)

func main() {
	if err := run(); err != nil {
		observability.Logger().WithError(err).Error("migration command failed")
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}
	telemetry, err := observability.New(observability.Config{
		Enabled:            cfg.NewRelicEnabled,
		AppName:            cfg.NewRelicAppName,
		LicenseKey:         cfg.NewRelicLicenseKey,
		DistributedTracing: cfg.NewRelicDistributedTracing,
		LogForwarding:      cfg.NewRelicLogForwarding,
		LogLevel:           cfg.LogLevel,
	})
	if err != nil {
		return err
	}
	defer telemetry.Shutdown(5 * time.Second)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	transaction := telemetry.App.StartTransaction("DatabaseMigration")
	defer transaction.End()
	ctx = newrelic.NewContext(ctx, transaction)

	store, err := postgres.OpenWithRetry(
		ctx, cfg.DatabaseURL,
		cfg.DBConnectMaxAttempts, cfg.DBConnectMaxBackoff, telemetry.Logger,
		postgres.WithLogger(telemetry.Logger),
	)
	if err != nil {
		return fmt.Errorf("connect postgres: %w", err)
	}
	defer store.Close()
	if err := bootstrap.ApplyMigrationsWithRetry(
		ctx, store.ORM,
		cfg.DBConnectMaxAttempts, cfg.DBConnectMaxBackoff, telemetry.Logger,
	); err != nil {
		return err
	}
	telemetry.Logger.WithContext(ctx).Info("GORM migrations applied")
	return nil
}
