-- Code-generation schema snapshot for sqlc.
-- Runtime schema changes are versioned Go migrations in ../migrations and run through GORM.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name text NOT NULL CHECK (length(btrim(full_name)) BETWEEN 1 AND 160),
    username text NOT NULL UNIQUE
        CHECK (username = lower(username))
        CHECK (username ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
    password_hash text NOT NULL,
    role text NOT NULL CHECK (role IN ('admin', 'superadmin')),
    is_active boolean NOT NULL DEFAULT true,
    must_change_password boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    CHECK (deleted_at IS NULL OR NOT is_active)
);

CREATE INDEX users_active_role_idx ON users (role)
    WHERE is_active AND deleted_at IS NULL;

CREATE TABLE terminals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    installation_id text NOT NULL UNIQUE CHECK (length(installation_id) BETWEEN 8 AND 200),
    name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
    public_key bytea NOT NULL CHECK (octet_length(public_key) = 32),
    platform text NOT NULL DEFAULT 'android' CHECK (platform = 'android'),
    device_model text,
    os_version text,
    app_version text,
    is_active boolean NOT NULL DEFAULT true,
    enrolled_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz,
    CHECK (revoked_at IS NULL OR NOT is_active)
);

CREATE TABLE data_spaces (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    mode text NOT NULL CHECK (mode IN ('production', 'sandbox')),
    generation bigint NOT NULL CHECK (generation > 0),
    status text NOT NULL CHECK (status IN ('active', 'retired', 'purged')),
    activated_at timestamptz NOT NULL DEFAULT now(),
    retired_at timestamptz,
    purge_after timestamptz,
    purged_at timestamptz,
    CONSTRAINT data_spaces_mode_generation_key UNIQUE (mode, generation),
    CONSTRAINT data_spaces_lifecycle_shape CHECK (
        (status = 'active' AND retired_at IS NULL AND purge_after IS NULL AND purged_at IS NULL) OR
        (status = 'retired' AND retired_at IS NOT NULL AND purge_after IS NOT NULL AND purged_at IS NULL) OR
        (status = 'purged' AND retired_at IS NOT NULL AND purge_after IS NOT NULL AND purged_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX data_spaces_active_mode_key ON data_spaces (mode)
    WHERE status = 'active';

INSERT INTO data_spaces (id, mode, generation, status)
VALUES ('00000000-0000-4000-8000-000000000100', 'production', 1, 'active');

CREATE TABLE sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id),
    terminal_id uuid REFERENCES terminals(id),
    data_space_id uuid NOT NULL DEFAULT '00000000-0000-4000-8000-000000000100'
        REFERENCES data_spaces(id),
    token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz,
    revoked_reason text,
    CHECK ((revoked_at IS NULL AND revoked_reason IS NULL) OR
           (revoked_at IS NOT NULL AND length(btrim(revoked_reason)) > 0)),
    UNIQUE (id, data_space_id)
);

CREATE INDEX sessions_user_live_idx ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_data_space_live_idx ON sessions (data_space_id, user_id)
    WHERE revoked_at IS NULL;
CREATE INDEX sessions_data_space_idx ON sessions (data_space_id)
    WHERE data_space_id IS NOT NULL;
CREATE INDEX sessions_terminal_live_idx ON sessions (terminal_id)
    WHERE revoked_at IS NULL;

CREATE TABLE packages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    data_space_id uuid NOT NULL DEFAULT '00000000-0000-4000-8000-000000000100'
        REFERENCES data_spaces(id),
    code text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'),
    current_revision integer NOT NULL DEFAULT 1 CHECK (current_revision > 0),
    source_package_id uuid REFERENCES packages(id),
    source_revision integer,
    created_by uuid REFERENCES users(id),
    updated_by uuid REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    deleted_by uuid REFERENCES users(id),
    UNIQUE (data_space_id, code),
    UNIQUE (id, data_space_id),
    CHECK ((source_package_id IS NULL AND source_revision IS NULL) OR
           (source_package_id IS NOT NULL AND source_revision > 0))
);

CREATE TABLE package_revisions (
    package_id uuid NOT NULL REFERENCES packages(id),
    revision integer NOT NULL CHECK (revision > 0),
    data_space_id uuid NOT NULL DEFAULT '00000000-0000-4000-8000-000000000100'
        REFERENCES data_spaces(id),
    name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
    description text NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
    unit_price bigint NOT NULL CHECK (unit_price > 0),
    change_reason text,
    created_by uuid REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (package_id, revision),
    UNIQUE (package_id, revision, data_space_id),
    FOREIGN KEY (package_id, data_space_id)
        REFERENCES packages(id, data_space_id)
);

ALTER TABLE packages ADD CONSTRAINT packages_current_revision_fk
    FOREIGN KEY (id, current_revision)
    REFERENCES package_revisions(package_id, revision)
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE packages ADD CONSTRAINT packages_current_revision_space_fkey
    FOREIGN KEY (id, current_revision, data_space_id)
    REFERENCES package_revisions(package_id, revision, data_space_id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX packages_data_space_live_idx
    ON packages (data_space_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX packages_source_package_idx ON packages (source_package_id)
    WHERE source_package_id IS NOT NULL;
CREATE INDEX package_revisions_data_space_idx ON package_revisions (data_space_id);

CREATE TABLE transactions (
    id text PRIMARY KEY
        CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
    data_space_id uuid NOT NULL DEFAULT '00000000-0000-4000-8000-000000000100'
        REFERENCES data_spaces(id),
    current_revision integer NOT NULL DEFAULT 1 CHECK (current_revision > 0),
    occurred_at timestamptz NOT NULL,
    server_received_at timestamptz NOT NULL DEFAULT now(),
    origin_actor_id uuid NOT NULL REFERENCES users(id),
    origin_session_id uuid NOT NULL REFERENCES sessions(id),
    terminal_id uuid REFERENCES terminals(id),
    updated_by uuid NOT NULL REFERENCES users(id),
    subtotal bigint NOT NULL CHECK (subtotal >= 0),
    total bigint NOT NULL CHECK (total >= 0 AND total = subtotal),
    payment_amount bigint NOT NULL CHECK (payment_amount >= 0),
    payment_method text NOT NULL DEFAULT 'legacy'
        CHECK (payment_method IN ('cash', 'qris', 'legacy')),
    qris_payload_hash text,
    payment_status text NOT NULL DEFAULT 'pending'
        CHECK (payment_status IN ('pending', 'success', 'failed')),
    payment_confirmed_revision integer,
    print_state text NOT NULL DEFAULT 'pending'
        CHECK (print_state IN ('pending', 'success', 'failed', 'unknown', 'needs-reprint')),
    latest_printed_revision integer,
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    deleted_by uuid REFERENCES users(id),
    delete_reason text,
    CHECK ((payment_status = 'success' AND payment_confirmed_revision = current_revision) OR
           (payment_status IN ('pending', 'failed') AND payment_confirmed_revision IS NULL)),
    CHECK (qris_payload_hash IS NULL OR
           (payment_method = 'qris' AND qris_payload_hash ~ '^[0-9a-f]{64}$')),
    CHECK ((deleted_at IS NULL AND deleted_by IS NULL AND delete_reason IS NULL) OR
           (deleted_at IS NOT NULL AND deleted_by IS NOT NULL AND length(btrim(delete_reason)) > 0)),
    UNIQUE (id, data_space_id),
    FOREIGN KEY (origin_session_id, data_space_id)
        REFERENCES sessions(id, data_space_id)
);

CREATE INDEX transactions_data_space_occurred_idx
    ON transactions (data_space_id, occurred_at DESC, id DESC);
CREATE INDEX transactions_data_space_paid_occurred_idx
    ON transactions (data_space_id, occurred_at)
    INCLUDE (total, payment_amount, payment_method, current_revision, payment_confirmed_revision)
    WHERE deleted_at IS NULL AND payment_status = 'success';
CREATE INDEX transactions_data_space_actor_occurred_idx
    ON transactions (data_space_id, origin_actor_id, occurred_at DESC, id DESC);
CREATE INDEX transactions_origin_session_idx ON transactions (origin_session_id);

-- Additive-rollout compatibility for pre-data-space replicas. Remove only in a
-- future migration after every old replica is known to be gone.
CREATE OR REPLACE FUNCTION maintain_legacy_production_payment_amount()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.data_space_id = '00000000-0000-4000-8000-000000000100'::uuid THEN
        IF TG_OP = 'INSERT' AND NEW.payment_amount IS NULL THEN
            NEW.payment_amount := NEW.total;
        ELSIF TG_OP = 'UPDATE'
           AND NEW.total IS DISTINCT FROM OLD.total
           AND NEW.payment_amount IS NOT DISTINCT FROM OLD.payment_amount THEN
            NEW.payment_amount := NEW.total;
        END IF;
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER transactions_legacy_production_payment_amount
    BEFORE INSERT OR UPDATE OF total, payment_amount, data_space_id ON transactions
    FOR EACH ROW EXECUTE FUNCTION maintain_legacy_production_payment_amount();

CREATE TABLE transaction_revisions (
    transaction_id text NOT NULL REFERENCES transactions(id),
    revision integer NOT NULL CHECK (revision > 0),
    data_space_id uuid NOT NULL DEFAULT '00000000-0000-4000-8000-000000000100'
        REFERENCES data_spaces(id),
    base_revision integer CHECK (base_revision IS NULL OR base_revision > 0),
    change_type text NOT NULL CHECK (change_type IN ('create', 'correction')),
    reason text,
    before_snapshot jsonb,
    after_snapshot jsonb NOT NULL,
    qris_payload_hash text,
    payment_amount bigint CHECK (payment_amount IS NULL OR payment_amount >= 0),
    origin_actor_id uuid NOT NULL REFERENCES users(id),
    origin_session_id uuid NOT NULL REFERENCES sessions(id),
    terminal_id uuid REFERENCES terminals(id),
    submitted_by_actor_id uuid NOT NULL REFERENCES users(id),
    submitted_by_session_id uuid NOT NULL REFERENCES sessions(id),
    client_occurred_at timestamptz NOT NULL,
    server_received_at timestamptz NOT NULL DEFAULT now(),
    CHECK (qris_payload_hash IS NULL OR
           ((after_snapshot ->> 'paymentMethod') = 'qris' AND
            qris_payload_hash ~ '^[0-9a-f]{64}$')),
    PRIMARY KEY (transaction_id, revision),
    UNIQUE (transaction_id, revision, data_space_id),
    FOREIGN KEY (transaction_id, data_space_id)
        REFERENCES transactions(id, data_space_id),
    FOREIGN KEY (origin_session_id, data_space_id)
        REFERENCES sessions(id, data_space_id),
    FOREIGN KEY (submitted_by_session_id, data_space_id)
        REFERENCES sessions(id, data_space_id),
    CHECK ((change_type = 'create' AND revision = 1 AND base_revision IS NULL AND reason IS NULL AND before_snapshot IS NULL)
        OR (change_type = 'correction' AND revision > 1 AND base_revision = revision - 1
            AND length(btrim(reason)) >= 5 AND before_snapshot IS NOT NULL))
);

ALTER TABLE transactions ADD CONSTRAINT transactions_current_revision_fk
    FOREIGN KEY (id, current_revision)
    REFERENCES transaction_revisions(transaction_id, revision)
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE transactions ADD CONSTRAINT transactions_current_revision_space_fkey
    FOREIGN KEY (id, current_revision, data_space_id)
    REFERENCES transaction_revisions(transaction_id, revision, data_space_id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX transaction_revisions_data_space_idx ON transaction_revisions (data_space_id);
CREATE INDEX transaction_revisions_origin_session_idx
    ON transaction_revisions (origin_session_id);
CREATE INDEX transaction_revisions_submitted_session_idx
    ON transaction_revisions (submitted_by_session_id);

CREATE TABLE transaction_items (
    transaction_id text NOT NULL,
    revision integer NOT NULL,
    line_number integer NOT NULL CHECK (line_number > 0),
    data_space_id uuid NOT NULL DEFAULT '00000000-0000-4000-8000-000000000100'
        REFERENCES data_spaces(id),
    package_id uuid NOT NULL,
    package_revision integer NOT NULL,
    package_code text NOT NULL,
    package_name text NOT NULL,
    package_description text NOT NULL DEFAULT '',
    unit_price bigint NOT NULL CHECK (unit_price > 0),
    quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 999),
    line_total bigint NOT NULL CHECK (line_total = unit_price * quantity),
    PRIMARY KEY (transaction_id, revision, line_number),
    FOREIGN KEY (transaction_id, revision)
        REFERENCES transaction_revisions(transaction_id, revision),
    FOREIGN KEY (package_id, package_revision)
        REFERENCES package_revisions(package_id, revision),
    FOREIGN KEY (transaction_id, revision, data_space_id)
        REFERENCES transaction_revisions(transaction_id, revision, data_space_id),
    FOREIGN KEY (package_id, package_revision, data_space_id)
        REFERENCES package_revisions(package_id, revision, data_space_id)
);

CREATE INDEX transaction_items_current_filter_idx
    ON transaction_items (package_id, transaction_id, revision);
CREATE INDEX transaction_items_data_space_idx ON transaction_items (data_space_id);

CREATE TABLE print_attempts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    data_space_id uuid NOT NULL DEFAULT '00000000-0000-4000-8000-000000000100'
        REFERENCES data_spaces(id),
    transaction_id text NOT NULL,
    transaction_revision integer NOT NULL,
    terminal_id uuid REFERENCES terminals(id),
    actor_id uuid NOT NULL REFERENCES users(id),
    session_id uuid NOT NULL REFERENCES sessions(id),
    status text NOT NULL CHECK (status IN ('pending', 'success', 'failed', 'unknown')),
    is_copy boolean NOT NULL DEFAULT false,
    printer_kind text NOT NULL CHECK (printer_kind IN ('simulator', 'bluetooth', 'integrated')),
    printer_identifier text,
    error_code text,
    error_message text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    client_occurred_at timestamptz NOT NULL,
    server_received_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (transaction_id, transaction_revision)
        REFERENCES transaction_revisions(transaction_id, revision),
    FOREIGN KEY (transaction_id, transaction_revision, data_space_id)
        REFERENCES transaction_revisions(transaction_id, revision, data_space_id),
    FOREIGN KEY (session_id, data_space_id)
        REFERENCES sessions(id, data_space_id),
    CHECK ((status IN ('failed', 'unknown')) OR (error_code IS NULL AND error_message IS NULL))
);

CREATE INDEX print_attempts_transaction_idx
    ON print_attempts (transaction_id, server_received_at DESC);
CREATE INDEX print_attempts_data_space_idx ON print_attempts (data_space_id);
CREATE INDEX print_attempts_session_idx ON print_attempts (session_id);

CREATE TABLE audit_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    data_space_id uuid NOT NULL DEFAULT '00000000-0000-4000-8000-000000000100'
        REFERENCES data_spaces(id),
    event_type text NOT NULL,
    aggregate_type text NOT NULL,
    aggregate_id text NOT NULL,
    origin_actor_id uuid REFERENCES users(id),
    origin_session_id uuid REFERENCES sessions(id),
    submitted_by_actor_id uuid REFERENCES users(id),
    submitted_by_session_id uuid REFERENCES sessions(id),
    terminal_id uuid REFERENCES terminals(id),
    before_values jsonb,
    after_values jsonb,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at timestamptz NOT NULL,
    server_received_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (origin_session_id, data_space_id)
        REFERENCES sessions(id, data_space_id),
    FOREIGN KEY (submitted_by_session_id, data_space_id)
        REFERENCES sessions(id, data_space_id)
);

CREATE INDEX audit_events_aggregate_idx
    ON audit_events (aggregate_type, aggregate_id, server_received_at DESC);
CREATE INDEX audit_events_actor_idx
    ON audit_events (submitted_by_actor_id, server_received_at DESC);
CREATE INDEX audit_events_data_space_idx
    ON audit_events (data_space_id, server_received_at DESC);
CREATE INDEX audit_events_origin_session_idx ON audit_events (origin_session_id)
    WHERE origin_session_id IS NOT NULL;
CREATE INDEX audit_events_submitted_session_idx ON audit_events (submitted_by_session_id)
    WHERE submitted_by_session_id IS NOT NULL;

CREATE TABLE sync_changes (
    cursor bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    data_space_id uuid NOT NULL DEFAULT '00000000-0000-4000-8000-000000000100'
        REFERENCES data_spaces(id),
    aggregate text NOT NULL CHECK (aggregate IN ('user', 'package', 'transaction', 'print_attempt', 'terminal')),
    aggregate_id text NOT NULL,
    action text NOT NULL CHECK (action IN ('created', 'updated', 'deleted')),
    revision integer,
    payload jsonb NOT NULL,
    tombstone boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((tombstone AND action = 'deleted') OR NOT tombstone)
);

CREATE INDEX sync_changes_aggregate_idx
    ON sync_changes (aggregate, aggregate_id, cursor DESC);
CREATE INDEX sync_changes_data_space_cursor_idx
    ON sync_changes (data_space_id, cursor);

CREATE TABLE idempotency_records (
    data_space_id uuid NOT NULL DEFAULT '00000000-0000-4000-8000-000000000100'
        REFERENCES data_spaces(id),
    terminal_id uuid NOT NULL REFERENCES terminals(id),
    operation_id text NOT NULL CHECK (length(operation_id) BETWEEN 8 AND 100),
    request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
    response_status integer NOT NULL CHECK (response_status BETWEEN 100 AND 599),
    response jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (data_space_id, terminal_id, operation_id)
);

CREATE OR REPLACE FUNCTION reject_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE purge_space text;
BEGIN
    purge_space := current_setting('app.sandbox_purge_data_space_id', true);
    IF TG_OP = 'DELETE' AND purge_space IS NOT NULL
       AND (to_jsonb(OLD) ->> 'data_space_id') = purge_space
       AND EXISTS (
           SELECT 1 FROM data_spaces
           WHERE id = purge_space::uuid AND mode = 'sandbox'
             AND status = 'retired' AND purge_after <= now()
       ) THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
        USING ERRCODE = '55000';
END
$$;

CREATE TRIGGER package_revisions_append_only
    BEFORE UPDATE OR DELETE ON package_revisions
    FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER transaction_revisions_append_only
    BEFORE UPDATE OR DELETE ON transaction_revisions
    FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER transaction_items_append_only
    BEFORE UPDATE OR DELETE ON transaction_items
    FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER print_attempts_append_only
    BEFORE UPDATE OR DELETE ON print_attempts
    FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER audit_events_append_only
    BEFORE UPDATE OR DELETE ON audit_events
    FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER sync_changes_append_only
    BEFORE UPDATE OR DELETE ON sync_changes
    FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER idempotency_records_append_only
    BEFORE UPDATE OR DELETE ON idempotency_records
    FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

INSERT INTO packages (id, code, current_revision)
VALUES
    ('00000000-0000-4000-8000-000000000001', 'STANDARD', 1),
    ('00000000-0000-4000-8000-000000000002', 'SUNRISE', 1)
ON CONFLICT (id) DO NOTHING;

INSERT INTO package_revisions
    (package_id, revision, name, description, unit_price, change_reason)
VALUES
    ('00000000-0000-4000-8000-000000000001', 1, 'Paket Standar', 'Paket sewa motor standar', 70000, 'Paket awal sistem'),
    ('00000000-0000-4000-8000-000000000002', 1, 'Paket Sunrise', 'Paket sewa motor sunrise', 100000, 'Paket awal sistem')
ON CONFLICT (package_id, revision) DO NOTHING;
