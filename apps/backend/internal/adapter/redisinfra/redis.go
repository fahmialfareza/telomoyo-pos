package redisinfra

import (
	"context"
	"encoding/hex"
	"fmt"
	"time"

	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/observability"
	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

type Cache struct {
	client *redis.Client
	ttl    time.Duration
}

func New(rawURL string, ttl time.Duration) (*Cache, error) {
	options, err := redis.ParseURL(rawURL)
	if err != nil {
		return nil, fmt.Errorf("parse REDIS_URL: %w", err)
	}
	// Serverless Redis (e.g. Railway) can sleep through cold starts; explicit
	// dial and retry budgets give a waking instance time to come up. Callers
	// already treat Redis errors as cache-miss/allow, so PostgreSQL stays the
	// source of truth while Redis is unreachable.
	options.DialTimeout = 5 * time.Second
	options.ReadTimeout = 3 * time.Second
	options.WriteTimeout = 3 * time.Second
	options.MaxRetries = 5
	options.MinRetryBackoff = 200 * time.Millisecond
	options.MaxRetryBackoff = 2 * time.Second
	return &Cache{client: redis.NewClient(options), ttl: ttl}, nil
}

func (c *Cache) Close() error { return c.client.Close() }

func (c *Cache) Ping(ctx context.Context) error {
	defer observability.StartSegment(ctx, "Redis.Ping")()
	err := c.client.Ping(ctx).Err()
	if err != nil {
		observability.NoticeError(ctx, err, "ping Redis")
	}
	return err
}

func (c *Cache) Get(ctx context.Context, tokenHash []byte) (uuid.UUID, bool) {
	defer observability.StartSegment(ctx, "Redis.GetSession")()
	value, err := c.client.Get(ctx, c.key(tokenHash)).Result()
	if err != nil {
		if err != redis.Nil {
			observability.NoticeError(ctx, err, "get Redis session")
		}
		return uuid.Nil, false
	}
	id, err := uuid.Parse(value)
	if err != nil {
		observability.NoticeError(ctx, err, "parse Redis session")
	}
	return id, err == nil
}

func (c *Cache) Set(ctx context.Context, tokenHash []byte, sessionID uuid.UUID) {
	defer observability.StartSegment(ctx, "Redis.SetSession")()
	if err := c.client.Set(ctx, c.key(tokenHash), sessionID.String(), c.ttl).Err(); err != nil {
		observability.NoticeError(ctx, err, "set Redis session")
	}
}

func (c *Cache) Delete(ctx context.Context, tokenHash []byte) {
	defer observability.StartSegment(ctx, "Redis.DeleteSession")()
	if err := c.client.Del(ctx, c.key(tokenHash)).Err(); err != nil {
		observability.NoticeError(ctx, err, "delete Redis session")
	}
}

func (c *Cache) key(tokenHash []byte) string {
	return "sewa-motor:session-index:" + hex.EncodeToString(tokenHash)
}

func (c *Cache) Allow(ctx context.Context, key string, limit int, window time.Duration) (bool, error) {
	defer observability.StartSegment(ctx, "Redis.AllowRateLimit")()
	redisKey := "sewa-motor:rate:" + key
	count, err := c.client.Incr(ctx, redisKey).Result()
	if err != nil {
		observability.NoticeError(ctx, err, "increment Redis rate limit")
		return true, err
	}
	if count == 1 {
		if err := c.client.Expire(ctx, redisKey, window).Err(); err != nil {
			observability.NoticeError(ctx, err, "expire Redis rate limit")
			return true, err
		}
	}
	return count <= int64(limit), nil
}

type Noop struct{}

func (Noop) Get(ctx context.Context, _ []byte) (uuid.UUID, bool) {
	defer observability.StartSegment(ctx, "Redis.Noop.GetSession")()
	return uuid.Nil, false
}
func (Noop) Set(ctx context.Context, _ []byte, _ uuid.UUID) {
	defer observability.StartSegment(ctx, "Redis.Noop.SetSession")()
}
func (Noop) Delete(ctx context.Context, _ []byte) {
	defer observability.StartSegment(ctx, "Redis.Noop.DeleteSession")()
}
func (Noop) Allow(ctx context.Context, _ string, _ int, _ time.Duration) (bool, error) {
	defer observability.StartSegment(ctx, "Redis.Noop.AllowRateLimit")()
	return true, nil
}
