package migrations

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func TestQueryIndexesMigrationCreatesIndexes(t *testing.T) {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		t.Skip("DATABASE_URL is not configured")
	}
	base, err := gorm.Open(postgres.Open(databaseURL), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	schema := "query_indexes_migration_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if err = base.Exec(`CREATE SCHEMA "` + schema + `"`).Error; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		base.Exec(`DROP SCHEMA "` + schema + `" CASCADE`)
		if db, e := base.DB(); e == nil {
			db.Close()
		}
	})
	db, err := gorm.Open(postgres.Open(sandboxScopedDatabaseURL(t, databaseURL, schema)), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if sql, e := db.DB(); e == nil {
			sql.Close()
		}
	})
	if err = Apply(context.Background(), db); err != nil {
		t.Fatal(err)
	}
	var found []string
	if err = db.Raw(`SELECT indexname FROM pg_indexes WHERE schemaname = ? AND indexname IN ?`, schema, queryIndexNames).
		Scan(&found).Error; err != nil {
		t.Fatal(err)
	}
	if len(found) != len(queryIndexNames) {
		t.Fatalf("query indexes found %v, want %v", found, queryIndexNames)
	}
	var stale []string
	if err = db.Raw(`SELECT indexname FROM pg_indexes WHERE schemaname = ? AND indexname IN ?`, schema, droppedQueryIndexNames).
		Scan(&stale).Error; err != nil {
		t.Fatal(err)
	}
	if len(stale) != 0 {
		t.Fatalf("superseded indexes remain: %v", stale)
	}
}
