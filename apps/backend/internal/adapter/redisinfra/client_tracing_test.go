package redisinfra

import (
	"context"
	"reflect"
	"testing"

	"github.com/newrelic/go-agent/v3/newrelic"
	"github.com/redis/go-redis/v9"
)

func TestClientTracingReportsRedisDatastoreMetadata(t *testing.T) {
	cases := []struct {
		name string
		url  string
		host string
		port string
	}{
		{
			name: "redis",
			url:  "redis://cache.internal:6379/0",
			host: "cache.internal",
			port: "6379",
		},
		{
			name: "rediss",
			url:  "rediss://redis.railway.internal:6380/0",
			host: "redis.railway.internal",
			port: "6380",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			options, err := redis.ParseURL(tc.url)
			if err != nil {
				t.Fatal(err)
			}
			hook := newRedisDatastoreHook(options)
			product, host, port, includeKeys := inspectRedisHook(t, hook)
			if product != string(newrelic.DatastoreRedis) {
				t.Errorf("product = %q, want %q", product, newrelic.DatastoreRedis)
			}
			if host != tc.host || port != tc.port {
				t.Errorf("instance = %s:%s, want %s:%s", host, port, tc.host, tc.port)
			}
			if includeKeys {
				t.Error("Redis keys must not be copied into datastore telemetry")
			}
		})
	}
}

func TestClientTracingProcessHookRunsWithoutTransaction(t *testing.T) {
	options, err := redis.ParseURL("redis://cache.internal:6379/0")
	if err != nil {
		t.Fatal(err)
	}
	hook := newRedisDatastoreHook(options)
	called := false
	process := hook.ProcessHook(func(context.Context, redis.Cmder) error {
		called = true
		return nil
	})
	cmd := redis.NewCmd(context.Background(), "get", "sewa-motor:session-index:private-value-must-not-enter-telemetry")
	if err := process(context.Background(), cmd); err != nil {
		t.Fatal(err)
	}
	if !called {
		t.Fatal("ProcessHook must invoke the next handler without a New Relic transaction")
	}
}

func inspectRedisHook(t *testing.T, hook redis.Hook) (product, host, port string, includeKeys bool) {
	t.Helper()
	value := reflect.ValueOf(hook)
	if value.Kind() == reflect.Pointer {
		value = value.Elem()
	}
	if value.Kind() != reflect.Struct {
		t.Fatalf("redis datastore hook has type %T, want a struct", hook)
	}
	segment := value.FieldByName("segment")
	if !segment.IsValid() {
		t.Fatal("redis datastore hook is missing segment metadata")
	}
	includeKeysField := value.FieldByName("includeKeys")
	if !includeKeysField.IsValid() || includeKeysField.Kind() != reflect.Bool {
		t.Fatal("redis datastore hook is missing includeKeys")
	}
	return segment.FieldByName("Product").String(),
		segment.FieldByName("Host").String(),
		segment.FieldByName("PortPathOrID").String(),
		includeKeysField.Bool()
}
