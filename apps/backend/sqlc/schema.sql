-- Code-generation schema snapshot for sqlc.
-- Runtime schema changes are versioned Go migrations in ../migrations and run through GORM.
-- Regenerate from a fully migrated database:
--   pg_dump --schema-only --no-owner --no-privileges --no-comments \
--     --exclude-table=schema_migrations --exclude-table=schema_migrations_id_seq
-- then drop SET/\restrict lines, dump comments, and the public. qualifier.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE FUNCTION bind_data_space_tenant() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
		DECLARE owner_tenant uuid;
		BEGIN
			SELECT tenant_id INTO STRICT owner_tenant FROM data_spaces WHERE id=NEW.data_space_id;
			IF NEW.tenant_id IS NOT NULL AND NEW.tenant_id<>owner_tenant THEN RAISE EXCEPTION 'tenant/data space mismatch' USING ERRCODE='23514'; END IF;
			NEW.tenant_id:=owner_tenant; RETURN NEW;
		END $$;

CREATE FUNCTION bind_session_tenant() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
		DECLARE owner_tenant uuid;
		BEGIN
			IF NEW.context_kind='tenant' THEN
				SELECT tenant_id INTO STRICT owner_tenant FROM data_spaces WHERE id=NEW.data_space_id;
				IF NEW.tenant_id IS NOT NULL AND NEW.tenant_id<>owner_tenant THEN RAISE EXCEPTION 'session tenant mismatch' USING ERRCODE='23514'; END IF;
				NEW.tenant_id:=owner_tenant;
				IF NEW.membership_id IS NULL THEN SELECT id INTO STRICT NEW.membership_id FROM tenant_memberships WHERE tenant_id=owner_tenant AND user_id=NEW.user_id; END IF;
			END IF;
			RETURN NEW;
		END $$;

CREATE FUNCTION maintain_legacy_production_payment_amount() RETURNS trigger
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

CREATE FUNCTION protect_data_space_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN
			IF (NEW.id,NEW.tenant_id,NEW.mode,NEW.generation) IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.mode,OLD.generation) THEN
				RAISE EXCEPTION 'data space identity is immutable' USING ERRCODE='55000';
			END IF; RETURN NEW; END $$;

CREATE FUNCTION protect_session_scope() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN
		 IF (NEW.user_id,NEW.context_kind,NEW.tenant_id,NEW.membership_id,NEW.data_space_id,NEW.legacy_origin,NEW.protocol_version,NEW.sandbox_qris_policy)
		 IS DISTINCT FROM (OLD.user_id,OLD.context_kind,OLD.tenant_id,OLD.membership_id,OLD.data_space_id,OLD.legacy_origin,OLD.protocol_version,OLD.sandbox_qris_policy) THEN
		 RAISE EXCEPTION 'session scope and payment policy are immutable' USING ERRCODE='55000'; END IF;
		 IF OLD.terminal_id IS NOT NULL AND NEW.terminal_id IS DISTINCT FROM OLD.terminal_id THEN
		 RAISE EXCEPTION 'session enrollment is immutable' USING ERRCODE='55000'; END IF;
		 RETURN NEW; END $$;

CREATE FUNCTION reject_append_only_mutation() RETURNS trigger
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
			RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
		END
		$$;

CREATE TABLE audit_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_type text NOT NULL,
    aggregate_type text NOT NULL,
    aggregate_id text NOT NULL,
    origin_actor_id uuid,
    origin_session_id uuid,
    submitted_by_actor_id uuid,
    submitted_by_session_id uuid,
    terminal_id uuid,
    before_values jsonb,
    after_values jsonb,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    server_received_at timestamp with time zone DEFAULT now() NOT NULL,
    data_space_id uuid NOT NULL,
    tenant_id uuid NOT NULL
);

CREATE TABLE data_spaces (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    mode text NOT NULL,
    generation bigint NOT NULL,
    status text NOT NULL,
    activated_at timestamp with time zone DEFAULT now() NOT NULL,
    retired_at timestamp with time zone,
    purge_after timestamp with time zone,
    purged_at timestamp with time zone,
    tenant_id uuid NOT NULL,
    CONSTRAINT data_spaces_generation_check CHECK ((generation > 0)),
    CONSTRAINT data_spaces_lifecycle_shape CHECK ((((status = 'active'::text) AND (retired_at IS NULL) AND (purge_after IS NULL) AND (purged_at IS NULL)) OR ((status = 'retired'::text) AND (retired_at IS NOT NULL) AND (purge_after IS NOT NULL) AND (purged_at IS NULL)) OR ((status = 'purged'::text) AND (retired_at IS NOT NULL) AND (purge_after IS NOT NULL) AND (purged_at IS NOT NULL)))),
    CONSTRAINT data_spaces_mode_check CHECK ((mode = ANY (ARRAY['production'::text, 'sandbox'::text]))),
    CONSTRAINT data_spaces_status_check CHECK ((status = ANY (ARRAY['active'::text, 'retired'::text, 'purged'::text])))
);

CREATE TABLE idempotency_records (
    terminal_id uuid NOT NULL,
    operation_id text NOT NULL,
    request_hash bytea NOT NULL,
    response_status integer NOT NULL,
    response jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    data_space_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    CONSTRAINT idempotency_records_operation_id_length CHECK (((length(operation_id) >= 8) AND (length(operation_id) <= 100))),
    CONSTRAINT idempotency_records_request_hash_length CHECK ((octet_length(request_hash) = 32)),
    CONSTRAINT idempotency_records_response_status_range CHECK (((response_status >= 100) AND (response_status <= 599)))
);

CREATE TABLE package_revisions (
    package_id uuid NOT NULL,
    revision integer NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    unit_price bigint NOT NULL,
    change_reason text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    data_space_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    CONSTRAINT package_revisions_description_length CHECK ((length(description) <= 1000)),
    CONSTRAINT package_revisions_name_length CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 120))),
    CONSTRAINT package_revisions_revision_positive CHECK ((revision > 0)),
    CONSTRAINT package_revisions_unit_price_positive CHECK ((unit_price > 0))
);

CREATE TABLE packages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    current_revision integer DEFAULT 1 NOT NULL,
    created_by uuid,
    updated_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    deleted_by uuid,
    data_space_id uuid NOT NULL,
    source_package_id uuid,
    source_revision integer,
    tenant_id uuid NOT NULL,
    CONSTRAINT packages_code_format CHECK ((code ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'::text)),
    CONSTRAINT packages_current_revision_positive CHECK ((current_revision > 0)),
    CONSTRAINT packages_source_shape CHECK ((((source_package_id IS NULL) AND (source_revision IS NULL)) OR ((source_package_id IS NOT NULL) AND (source_revision > 0))))
);

CREATE TABLE platform_audit_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_type text NOT NULL,
    actor_id uuid,
    tenant_id uuid,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE print_attempts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    transaction_id text NOT NULL,
    transaction_revision integer NOT NULL,
    terminal_id uuid,
    actor_id uuid NOT NULL,
    session_id uuid NOT NULL,
    status text NOT NULL,
    is_copy boolean DEFAULT false NOT NULL,
    printer_kind text NOT NULL,
    printer_identifier text,
    error_code text,
    error_message text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    client_occurred_at timestamp with time zone NOT NULL,
    server_received_at timestamp with time zone DEFAULT now() NOT NULL,
    data_space_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    CONSTRAINT print_attempts_error_shape CHECK (((status = ANY (ARRAY['failed'::text, 'unknown'::text])) OR ((error_code IS NULL) AND (error_message IS NULL)))),
    CONSTRAINT print_attempts_printer_kind_allowed CHECK ((printer_kind = ANY (ARRAY['simulator'::text, 'bluetooth'::text, 'integrated'::text]))),
    CONSTRAINT print_attempts_status_allowed CHECK ((status = ANY (ARRAY['pending'::text, 'success'::text, 'failed'::text, 'unknown'::text])))
);

CREATE TABLE sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    terminal_id uuid,
    token_hash bytea NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    revoked_reason text,
    data_space_id uuid,
    context_kind text DEFAULT 'tenant'::text NOT NULL,
    tenant_id uuid,
    membership_id uuid,
    legacy_origin boolean DEFAULT false NOT NULL,
    protocol_version integer DEFAULT 2 NOT NULL,
    sandbox_qris_policy text DEFAULT 'fixed_1000'::text NOT NULL,
    CONSTRAINT sessions_context_kind_check CHECK ((context_kind = ANY (ARRAY['account'::text, 'tenant'::text, 'platform'::text]))),
    CONSTRAINT sessions_context_shape CHECK ((((context_kind = 'tenant'::text) AND (tenant_id IS NOT NULL) AND (membership_id IS NOT NULL) AND (data_space_id IS NOT NULL)) OR ((context_kind = ANY (ARRAY['account'::text, 'platform'::text])) AND (tenant_id IS NULL) AND (membership_id IS NULL) AND (data_space_id IS NULL) AND (terminal_id IS NULL)))),
    CONSTRAINT sessions_policy_protocol CHECK (((sandbox_qris_policy <> 'transaction_total'::text) OR (protocol_version >= 3))),
    CONSTRAINT sessions_protocol_version_check CHECK (((protocol_version >= 1) AND (protocol_version <= 3))),
    CONSTRAINT sessions_revocation_reason CHECK ((((revoked_at IS NULL) AND (revoked_reason IS NULL)) OR ((revoked_at IS NOT NULL) AND (length(btrim(revoked_reason)) > 0)))),
    CONSTRAINT sessions_sandbox_qris_policy_check CHECK ((sandbox_qris_policy = ANY (ARRAY['fixed_1000'::text, 'transaction_total'::text]))),
    CONSTRAINT sessions_token_hash_length CHECK ((octet_length(token_hash) = 32))
);

CREATE TABLE sync_changes (
    cursor bigint NOT NULL,
    aggregate text NOT NULL,
    aggregate_id text NOT NULL,
    action text NOT NULL,
    revision integer,
    payload jsonb NOT NULL,
    tombstone boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    data_space_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    CONSTRAINT sync_changes_action_allowed CHECK ((action = ANY (ARRAY['created'::text, 'updated'::text, 'deleted'::text]))),
    CONSTRAINT sync_changes_aggregate_allowed CHECK ((aggregate = ANY (ARRAY['user'::text, 'package'::text, 'transaction'::text, 'print_attempt'::text, 'terminal'::text, 'tenant_profile'::text, 'tenant_qris'::text, 'tenant_metadata'::text]))),
    CONSTRAINT sync_changes_tombstone_action CHECK (((tombstone AND (action = 'deleted'::text)) OR (NOT tombstone)))
);

ALTER TABLE sync_changes ALTER COLUMN cursor ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME sync_changes_cursor_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE tenant_invitations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    role text NOT NULL,
    code_hash bytea NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_by uuid NOT NULL,
    accepted_by uuid,
    accepted_at timestamp with time zone,
    revoked_at timestamp with time zone,
    is_initial_owner boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenant_invitations_check CHECK (((accepted_at IS NULL) = (accepted_by IS NULL))),
    CONSTRAINT tenant_invitations_check1 CHECK (((NOT is_initial_owner) OR (role = 'superadmin'::text))),
    CONSTRAINT tenant_invitations_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'superadmin'::text])))
);

CREATE TABLE tenant_memberships (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenant_memberships_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'superadmin'::text]))),
    CONSTRAINT tenant_memberships_status_check CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text])))
);

CREATE TABLE tenant_profile_revisions (
    tenant_id uuid NOT NULL,
    revision integer NOT NULL,
    business_name text NOT NULL,
    address text DEFAULT ''::text NOT NULL,
    phone text DEFAULT ''::text NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenant_profile_revisions_address_check CHECK ((length(address) <= 500)),
    CONSTRAINT tenant_profile_revisions_business_name_check CHECK (((length(btrim(business_name)) >= 1) AND (length(btrim(business_name)) <= 160))),
    CONSTRAINT tenant_profile_revisions_phone_check CHECK ((length(phone) <= 50)),
    CONSTRAINT tenant_profile_revisions_revision_check CHECK ((revision > 0))
);

CREATE TABLE tenant_qris_revisions (
    tenant_id uuid NOT NULL,
    revision integer NOT NULL,
    payload_hash text NOT NULL,
    static_payload text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenant_qris_revisions_payload_hash_check CHECK ((payload_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT tenant_qris_revisions_revision_check CHECK ((revision > 0)),
    CONSTRAINT tenant_qris_revisions_static_payload_check CHECK (((length(static_payload) >= 1) AND (length(static_payload) <= 4096)))
);

CREATE TABLE tenants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    status text NOT NULL,
    profile_revision integer DEFAULT 1 NOT NULL,
    qris_revision integer,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    management_revision integer DEFAULT 1 NOT NULL,
    sandbox_enabled_override boolean,
    CONSTRAINT tenants_management_revision_check CHECK ((management_revision > 0)),
    CONSTRAINT tenants_name_check CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 160))),
    CONSTRAINT tenants_slug_check CHECK ((slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'::text)),
    CONSTRAINT tenants_status_check CHECK ((status = ANY (ARRAY['pending_setup'::text, 'active'::text, 'suspended'::text])))
);

CREATE TABLE terminals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    installation_id text NOT NULL,
    name text NOT NULL,
    public_key bytea NOT NULL,
    platform text DEFAULT 'android'::text NOT NULL,
    device_model text,
    os_version text,
    app_version text,
    is_active boolean DEFAULT true NOT NULL,
    enrolled_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    tenant_id uuid NOT NULL,
    CONSTRAINT terminals_android_only CHECK ((platform = 'android'::text)),
    CONSTRAINT terminals_installation_id_length CHECK (((length(installation_id) >= 8) AND (length(installation_id) <= 200))),
    CONSTRAINT terminals_name_length CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 120))),
    CONSTRAINT terminals_public_key_length CHECK ((octet_length(public_key) = 32)),
    CONSTRAINT terminals_revoked_inactive CHECK (((revoked_at IS NULL) OR (NOT is_active)))
);

CREATE TABLE transaction_items (
    transaction_id text NOT NULL,
    revision integer NOT NULL,
    line_number integer NOT NULL,
    package_id uuid NOT NULL,
    package_revision integer NOT NULL,
    package_code text NOT NULL,
    package_name text NOT NULL,
    package_description text DEFAULT ''::text NOT NULL,
    unit_price bigint NOT NULL,
    quantity integer NOT NULL,
    line_total bigint NOT NULL,
    data_space_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    CONSTRAINT transaction_items_line_number_positive CHECK ((line_number > 0)),
    CONSTRAINT transaction_items_line_total CHECK ((line_total = (unit_price * quantity))),
    CONSTRAINT transaction_items_quantity_range CHECK (((quantity >= 1) AND (quantity <= 999))),
    CONSTRAINT transaction_items_unit_price_positive CHECK ((unit_price > 0))
);

CREATE TABLE transaction_revisions (
    transaction_id text NOT NULL,
    revision integer NOT NULL,
    base_revision integer,
    change_type text NOT NULL,
    reason text,
    before_snapshot jsonb,
    after_snapshot jsonb NOT NULL,
    origin_actor_id uuid NOT NULL,
    origin_session_id uuid NOT NULL,
    terminal_id uuid,
    submitted_by_actor_id uuid NOT NULL,
    submitted_by_session_id uuid NOT NULL,
    client_occurred_at timestamp with time zone NOT NULL,
    server_received_at timestamp with time zone DEFAULT now() NOT NULL,
    qris_payload_hash text,
    data_space_id uuid NOT NULL,
    payment_amount bigint,
    receipt_identity jsonb NOT NULL,
    tenant_id uuid NOT NULL,
    CONSTRAINT transaction_revisions_base_revision_positive CHECK (((base_revision IS NULL) OR (base_revision > 0))),
    CONSTRAINT transaction_revisions_change_type_allowed CHECK ((change_type = ANY (ARRAY['create'::text, 'correction'::text]))),
    CONSTRAINT transaction_revisions_payment_amount_nonnegative CHECK (((payment_amount IS NULL) OR (payment_amount >= 0))),
    CONSTRAINT transaction_revisions_qris_payload_hash_shape CHECK (((qris_payload_hash IS NULL) OR (((after_snapshot ->> 'paymentMethod'::text) = 'qris'::text) AND (qris_payload_hash ~ '^[0-9a-f]{64}$'::text)))),
    CONSTRAINT transaction_revisions_revision_positive CHECK ((revision > 0)),
    CONSTRAINT transaction_revisions_shape CHECK ((((change_type = 'create'::text) AND (revision = 1) AND (base_revision IS NULL) AND (reason IS NULL) AND (before_snapshot IS NULL)) OR ((change_type = 'correction'::text) AND (revision > 1) AND (base_revision = (revision - 1)) AND (length(btrim(reason)) >= 5) AND (before_snapshot IS NOT NULL))))
);

CREATE TABLE transactions (
    id text NOT NULL,
    current_revision integer DEFAULT 1 NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    server_received_at timestamp with time zone DEFAULT now() NOT NULL,
    origin_actor_id uuid NOT NULL,
    origin_session_id uuid NOT NULL,
    terminal_id uuid,
    updated_by uuid NOT NULL,
    subtotal bigint NOT NULL,
    total bigint NOT NULL,
    print_state text DEFAULT 'pending'::text NOT NULL,
    latest_printed_revision integer,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    deleted_by uuid,
    delete_reason text,
    payment_method text DEFAULT 'legacy'::text NOT NULL,
    payment_status text DEFAULT 'pending'::text NOT NULL,
    payment_confirmed_revision integer,
    qris_payload_hash text,
    data_space_id uuid NOT NULL,
    payment_amount bigint NOT NULL,
    receipt_profile_revision integer NOT NULL,
    receipt_identity jsonb NOT NULL,
    tenant_id uuid NOT NULL,
    CONSTRAINT transactions_current_revision_positive CHECK ((current_revision > 0)),
    CONSTRAINT transactions_deletion_metadata CHECK ((((deleted_at IS NULL) AND (deleted_by IS NULL) AND (delete_reason IS NULL)) OR ((deleted_at IS NOT NULL) AND (deleted_by IS NOT NULL) AND (length(btrim(delete_reason)) > 0)))),
    CONSTRAINT transactions_id_ulid CHECK ((id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'::text)),
    CONSTRAINT transactions_payment_amount_nonnegative CHECK ((payment_amount >= 0)),
    CONSTRAINT transactions_payment_confirmation_shape CHECK ((((payment_status = 'success'::text) AND (payment_confirmed_revision = current_revision)) OR ((payment_status = ANY (ARRAY['pending'::text, 'failed'::text])) AND (payment_confirmed_revision IS NULL)))),
    CONSTRAINT transactions_payment_method_allowed CHECK ((payment_method = ANY (ARRAY['cash'::text, 'qris'::text, 'legacy'::text]))),
    CONSTRAINT transactions_payment_status_allowed CHECK ((payment_status = ANY (ARRAY['pending'::text, 'success'::text, 'failed'::text]))),
    CONSTRAINT transactions_print_state_allowed CHECK ((print_state = ANY (ARRAY['pending'::text, 'success'::text, 'failed'::text, 'unknown'::text, 'needs-reprint'::text]))),
    CONSTRAINT transactions_qris_payload_hash_shape CHECK (((qris_payload_hash IS NULL) OR ((payment_method = 'qris'::text) AND (qris_payload_hash ~ '^[0-9a-f]{64}$'::text)))),
    CONSTRAINT transactions_subtotal_nonnegative CHECK ((subtotal >= 0)),
    CONSTRAINT transactions_total_matches_subtotal CHECK (((total >= 0) AND (total = subtotal)))
);

CREATE TABLE users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    full_name text NOT NULL,
    username text NOT NULL,
    password_hash text NOT NULL,
    role text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    must_change_password boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    is_platform_admin boolean DEFAULT false NOT NULL,
    CONSTRAINT users_deleted_inactive CHECK (((deleted_at IS NULL) OR (NOT is_active))),
    CONSTRAINT users_full_name_length CHECK (((length(btrim(full_name)) >= 1) AND (length(btrim(full_name)) <= 160))),
    CONSTRAINT users_role_allowed CHECK ((role = ANY (ARRAY['admin'::text, 'superadmin'::text]))),
    CONSTRAINT users_username_format CHECK (((username = lower(username)) AND (username ~ '^[a-z0-9][a-z0-9._-]{2,63}$'::text)))
);

ALTER TABLE ONLY audit_events
    ADD CONSTRAINT audit_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY data_spaces
    ADD CONSTRAINT data_spaces_pkey PRIMARY KEY (id);

ALTER TABLE ONLY data_spaces
    ADD CONSTRAINT data_spaces_tenant_id_key UNIQUE (tenant_id, id);

ALTER TABLE ONLY data_spaces
    ADD CONSTRAINT data_spaces_tenant_mode_generation_key UNIQUE (tenant_id, mode, generation);

ALTER TABLE ONLY idempotency_records
    ADD CONSTRAINT idempotency_records_pkey PRIMARY KEY (data_space_id, terminal_id, operation_id);

ALTER TABLE ONLY package_revisions
    ADD CONSTRAINT package_revisions_pkey PRIMARY KEY (package_id, revision);

ALTER TABLE ONLY package_revisions
    ADD CONSTRAINT package_revisions_space_key UNIQUE (package_id, revision, data_space_id);

ALTER TABLE ONLY packages
    ADD CONSTRAINT packages_id_data_space_key UNIQUE (id, data_space_id);

ALTER TABLE ONLY packages
    ADD CONSTRAINT packages_pkey PRIMARY KEY (id);

ALTER TABLE ONLY packages
    ADD CONSTRAINT packages_tenant_id_key UNIQUE (tenant_id, id);

ALTER TABLE ONLY platform_audit_events
    ADD CONSTRAINT platform_audit_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY print_attempts
    ADD CONSTRAINT print_attempts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_id_data_space_key UNIQUE (id, data_space_id);

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_tenant_id_key UNIQUE (tenant_id, id);

ALTER TABLE ONLY sync_changes
    ADD CONSTRAINT sync_changes_pkey PRIMARY KEY (cursor);

ALTER TABLE ONLY tenant_invitations
    ADD CONSTRAINT tenant_invitations_code_hash_key UNIQUE (code_hash);

ALTER TABLE ONLY tenant_invitations
    ADD CONSTRAINT tenant_invitations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY tenant_memberships
    ADD CONSTRAINT tenant_memberships_id_tenant_id_user_id_key UNIQUE (id, tenant_id, user_id);

ALTER TABLE ONLY tenant_memberships
    ADD CONSTRAINT tenant_memberships_pkey PRIMARY KEY (id);

ALTER TABLE ONLY tenant_memberships
    ADD CONSTRAINT tenant_memberships_tenant_id_user_id_key UNIQUE (tenant_id, user_id);

ALTER TABLE ONLY tenant_profile_revisions
    ADD CONSTRAINT tenant_profile_revisions_pkey PRIMARY KEY (tenant_id, revision);

ALTER TABLE ONLY tenant_qris_revisions
    ADD CONSTRAINT tenant_qris_revisions_pkey PRIMARY KEY (tenant_id, revision);

ALTER TABLE ONLY tenants
    ADD CONSTRAINT tenants_pkey PRIMARY KEY (id);

ALTER TABLE ONLY tenants
    ADD CONSTRAINT tenants_slug_key UNIQUE (slug);

ALTER TABLE ONLY terminals
    ADD CONSTRAINT terminals_pkey PRIMARY KEY (id);

ALTER TABLE ONLY terminals
    ADD CONSTRAINT terminals_tenant_id_key UNIQUE (tenant_id, id);

ALTER TABLE ONLY transaction_items
    ADD CONSTRAINT transaction_items_pkey PRIMARY KEY (transaction_id, revision, line_number);

ALTER TABLE ONLY transaction_revisions
    ADD CONSTRAINT transaction_revisions_pkey PRIMARY KEY (transaction_id, revision);

ALTER TABLE ONLY transaction_revisions
    ADD CONSTRAINT transaction_revisions_space_key UNIQUE (transaction_id, revision, data_space_id);

ALTER TABLE ONLY transactions
    ADD CONSTRAINT transactions_id_data_space_key UNIQUE (id, data_space_id);

ALTER TABLE ONLY transactions
    ADD CONSTRAINT transactions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

CREATE INDEX audit_events_actor_idx ON audit_events USING btree (submitted_by_actor_id, server_received_at DESC);

CREATE INDEX audit_events_aggregate_idx ON audit_events USING btree (aggregate_type, aggregate_id, server_received_at DESC);

CREATE INDEX audit_events_data_space_idx ON audit_events USING btree (data_space_id, server_received_at DESC);

CREATE INDEX audit_events_origin_session_idx ON audit_events USING btree (origin_session_id) WHERE (origin_session_id IS NOT NULL);

CREATE INDEX audit_events_submitted_session_idx ON audit_events USING btree (submitted_by_session_id) WHERE (submitted_by_session_id IS NOT NULL);

CREATE UNIQUE INDEX data_spaces_active_tenant_mode_key ON data_spaces USING btree (tenant_id, mode) WHERE (status = 'active'::text);

CREATE INDEX package_revisions_data_space_idx ON package_revisions USING btree (data_space_id);

CREATE UNIQUE INDEX packages_data_space_code_key ON packages USING btree (data_space_id, code);

CREATE INDEX packages_data_space_live_idx ON packages USING btree (data_space_id, updated_at DESC) WHERE (deleted_at IS NULL);

CREATE INDEX packages_source_package_idx ON packages USING btree (source_package_id) WHERE (source_package_id IS NOT NULL);

CREATE INDEX platform_audit_events_created_idx ON platform_audit_events USING btree (created_at DESC, id DESC);

CREATE INDEX print_attempts_data_space_idx ON print_attempts USING btree (data_space_id);

CREATE INDEX print_attempts_session_idx ON print_attempts USING btree (session_id);

CREATE INDEX print_attempts_transaction_idx ON print_attempts USING btree (transaction_id, server_received_at DESC);

CREATE INDEX sessions_data_space_idx ON sessions USING btree (data_space_id) WHERE (data_space_id IS NOT NULL);

CREATE INDEX sessions_data_space_live_idx ON sessions USING btree (data_space_id, user_id) WHERE (revoked_at IS NULL);

CREATE INDEX sessions_terminal_live_idx ON sessions USING btree (terminal_id) WHERE (revoked_at IS NULL);

CREATE UNIQUE INDEX sessions_token_hash_key ON sessions USING btree (token_hash);

CREATE INDEX sessions_user_live_idx ON sessions USING btree (user_id) WHERE (revoked_at IS NULL);

CREATE INDEX sync_changes_aggregate_idx ON sync_changes USING btree (aggregate, aggregate_id, cursor DESC);

CREATE INDEX sync_changes_data_space_cursor_idx ON sync_changes USING btree (data_space_id, cursor);

CREATE INDEX tenant_invitations_pending_idx ON tenant_invitations USING btree (tenant_id, expires_at) WHERE ((accepted_at IS NULL) AND (revoked_at IS NULL));

CREATE UNIQUE INDEX terminals_tenant_installation_key ON terminals USING btree (tenant_id, installation_id);

CREATE INDEX transaction_items_current_filter_idx ON transaction_items USING btree (package_id, transaction_id, revision);

CREATE INDEX transaction_items_data_space_idx ON transaction_items USING btree (data_space_id);

CREATE INDEX transaction_revisions_data_space_idx ON transaction_revisions USING btree (data_space_id);

CREATE INDEX transaction_revisions_origin_session_idx ON transaction_revisions USING btree (origin_session_id);

CREATE INDEX transaction_revisions_submitted_session_idx ON transaction_revisions USING btree (submitted_by_session_id);

CREATE INDEX transactions_data_space_actor_occurred_idx ON transactions USING btree (data_space_id, origin_actor_id, occurred_at DESC, id DESC);

CREATE INDEX transactions_data_space_id_prefix_idx ON transactions USING btree (data_space_id, id text_pattern_ops);

CREATE INDEX transactions_data_space_occurred_idx ON transactions USING btree (data_space_id, occurred_at DESC, id DESC);

CREATE INDEX transactions_data_space_paid_occurred_idx ON transactions USING btree (data_space_id, occurred_at) INCLUDE (total, payment_amount, payment_method, current_revision, payment_confirmed_revision) WHERE ((deleted_at IS NULL) AND (payment_status = 'success'::text));

CREATE INDEX transactions_origin_session_idx ON transactions USING btree (origin_session_id);

CREATE INDEX users_active_role_idx ON users USING btree (role) WHERE (is_active AND (deleted_at IS NULL));

CREATE UNIQUE INDEX users_username_key ON users USING btree (username);

CREATE TRIGGER audit_events_append_only BEFORE DELETE OR UPDATE ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

CREATE TRIGGER audit_events_bind_tenant BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION bind_data_space_tenant();

CREATE TRIGGER data_spaces_immutable_identity BEFORE UPDATE ON data_spaces FOR EACH ROW EXECUTE FUNCTION protect_data_space_identity();

CREATE TRIGGER idempotency_records_append_only BEFORE DELETE OR UPDATE ON idempotency_records FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

CREATE TRIGGER idempotency_records_bind_tenant BEFORE INSERT ON idempotency_records FOR EACH ROW EXECUTE FUNCTION bind_data_space_tenant();

CREATE TRIGGER package_revisions_append_only BEFORE DELETE OR UPDATE ON package_revisions FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

CREATE TRIGGER package_revisions_bind_tenant BEFORE INSERT ON package_revisions FOR EACH ROW EXECUTE FUNCTION bind_data_space_tenant();

CREATE TRIGGER packages_bind_tenant BEFORE INSERT ON packages FOR EACH ROW EXECUTE FUNCTION bind_data_space_tenant();

CREATE TRIGGER platform_audit_events_append_only BEFORE DELETE OR UPDATE ON platform_audit_events FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

CREATE TRIGGER print_attempts_append_only BEFORE DELETE OR UPDATE ON print_attempts FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

CREATE TRIGGER print_attempts_bind_tenant BEFORE INSERT ON print_attempts FOR EACH ROW EXECUTE FUNCTION bind_data_space_tenant();

CREATE TRIGGER sessions_bind_tenant BEFORE INSERT ON sessions FOR EACH ROW EXECUTE FUNCTION bind_session_tenant();

CREATE TRIGGER sessions_immutable_scope BEFORE UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION protect_session_scope();

CREATE TRIGGER sync_changes_append_only BEFORE DELETE OR UPDATE ON sync_changes FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

CREATE TRIGGER sync_changes_bind_tenant BEFORE INSERT ON sync_changes FOR EACH ROW EXECUTE FUNCTION bind_data_space_tenant();

CREATE TRIGGER tenant_profile_revisions_append_only BEFORE DELETE OR UPDATE ON tenant_profile_revisions FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

CREATE TRIGGER tenant_qris_revisions_append_only BEFORE DELETE OR UPDATE ON tenant_qris_revisions FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

CREATE TRIGGER transaction_items_append_only BEFORE DELETE OR UPDATE ON transaction_items FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

CREATE TRIGGER transaction_items_bind_tenant BEFORE INSERT ON transaction_items FOR EACH ROW EXECUTE FUNCTION bind_data_space_tenant();

CREATE TRIGGER transaction_revisions_append_only BEFORE DELETE OR UPDATE ON transaction_revisions FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

CREATE TRIGGER transaction_revisions_bind_tenant BEFORE INSERT ON transaction_revisions FOR EACH ROW EXECUTE FUNCTION bind_data_space_tenant();

CREATE TRIGGER transactions_bind_tenant BEFORE INSERT ON transactions FOR EACH ROW EXECUTE FUNCTION bind_data_space_tenant();

CREATE TRIGGER transactions_legacy_production_payment_amount BEFORE INSERT OR UPDATE OF total, payment_amount, data_space_id ON transactions FOR EACH ROW EXECUTE FUNCTION maintain_legacy_production_payment_amount();

ALTER TABLE ONLY audit_events
    ADD CONSTRAINT audit_events_data_space_id_fkey FOREIGN KEY (data_space_id) REFERENCES data_spaces(id);

ALTER TABLE ONLY audit_events
    ADD CONSTRAINT audit_events_origin_actor_id_fkey FOREIGN KEY (origin_actor_id) REFERENCES users(id);

ALTER TABLE ONLY audit_events
    ADD CONSTRAINT audit_events_origin_session_id_fkey FOREIGN KEY (origin_session_id) REFERENCES sessions(id);

ALTER TABLE ONLY audit_events
    ADD CONSTRAINT audit_events_origin_session_space_fkey FOREIGN KEY (origin_session_id, data_space_id) REFERENCES sessions(id, data_space_id);

ALTER TABLE ONLY audit_events
    ADD CONSTRAINT audit_events_submitted_by_actor_id_fkey FOREIGN KEY (submitted_by_actor_id) REFERENCES users(id);

ALTER TABLE ONLY audit_events
    ADD CONSTRAINT audit_events_submitted_by_session_id_fkey FOREIGN KEY (submitted_by_session_id) REFERENCES sessions(id);

ALTER TABLE ONLY audit_events
    ADD CONSTRAINT audit_events_submitted_session_space_fkey FOREIGN KEY (submitted_by_session_id, data_space_id) REFERENCES sessions(id, data_space_id);

ALTER TABLE ONLY audit_events
    ADD CONSTRAINT audit_events_tenant_space_fk FOREIGN KEY (tenant_id, data_space_id) REFERENCES data_spaces(tenant_id, id);

ALTER TABLE ONLY audit_events
    ADD CONSTRAINT audit_events_terminal_id_fkey FOREIGN KEY (terminal_id) REFERENCES terminals(id);

ALTER TABLE ONLY audit_events
    ADD CONSTRAINT audit_events_terminal_id_tenant_fk FOREIGN KEY (tenant_id, terminal_id) REFERENCES terminals(tenant_id, id);

ALTER TABLE ONLY data_spaces
    ADD CONSTRAINT data_spaces_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id);

ALTER TABLE ONLY idempotency_records
    ADD CONSTRAINT idempotency_records_data_space_id_fkey FOREIGN KEY (data_space_id) REFERENCES data_spaces(id);

ALTER TABLE ONLY idempotency_records
    ADD CONSTRAINT idempotency_records_tenant_space_fk FOREIGN KEY (tenant_id, data_space_id) REFERENCES data_spaces(tenant_id, id);

ALTER TABLE ONLY idempotency_records
    ADD CONSTRAINT idempotency_records_terminal_id_fkey FOREIGN KEY (terminal_id) REFERENCES terminals(id);

ALTER TABLE ONLY idempotency_records
    ADD CONSTRAINT idempotency_records_terminal_id_tenant_fk FOREIGN KEY (tenant_id, terminal_id) REFERENCES terminals(tenant_id, id);

ALTER TABLE ONLY package_revisions
    ADD CONSTRAINT package_revisions_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);

ALTER TABLE ONLY package_revisions
    ADD CONSTRAINT package_revisions_created_by_tenant_fk FOREIGN KEY (tenant_id, created_by) REFERENCES tenant_memberships(tenant_id, user_id);

ALTER TABLE ONLY package_revisions
    ADD CONSTRAINT package_revisions_data_space_id_fkey FOREIGN KEY (data_space_id) REFERENCES data_spaces(id);

ALTER TABLE ONLY package_revisions
    ADD CONSTRAINT package_revisions_package_id_fkey FOREIGN KEY (package_id) REFERENCES packages(id);

ALTER TABLE ONLY package_revisions
    ADD CONSTRAINT package_revisions_package_space_fkey FOREIGN KEY (package_id, data_space_id) REFERENCES packages(id, data_space_id);

ALTER TABLE ONLY package_revisions
    ADD CONSTRAINT package_revisions_tenant_space_fk FOREIGN KEY (tenant_id, data_space_id) REFERENCES data_spaces(tenant_id, id);

ALTER TABLE ONLY packages
    ADD CONSTRAINT packages_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);

ALTER TABLE ONLY packages
    ADD CONSTRAINT packages_created_by_tenant_fk FOREIGN KEY (tenant_id, created_by) REFERENCES tenant_memberships(tenant_id, user_id);

ALTER TABLE ONLY packages
    ADD CONSTRAINT packages_current_revision_fk FOREIGN KEY (id, current_revision) REFERENCES package_revisions(package_id, revision) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY packages
    ADD CONSTRAINT packages_current_revision_space_fkey FOREIGN KEY (id, current_revision, data_space_id) REFERENCES package_revisions(package_id, revision, data_space_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY packages
    ADD CONSTRAINT packages_data_space_id_fkey FOREIGN KEY (data_space_id) REFERENCES data_spaces(id);

ALTER TABLE ONLY packages
    ADD CONSTRAINT packages_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES users(id);

ALTER TABLE ONLY packages
    ADD CONSTRAINT packages_deleted_by_tenant_fk FOREIGN KEY (tenant_id, deleted_by) REFERENCES tenant_memberships(tenant_id, user_id);

ALTER TABLE ONLY packages
    ADD CONSTRAINT packages_source_package_id_fkey FOREIGN KEY (source_package_id) REFERENCES packages(id);

ALTER TABLE ONLY packages
    ADD CONSTRAINT packages_source_tenant_fk FOREIGN KEY (tenant_id, source_package_id) REFERENCES packages(tenant_id, id);

ALTER TABLE ONLY packages
    ADD CONSTRAINT packages_tenant_space_fk FOREIGN KEY (tenant_id, data_space_id) REFERENCES data_spaces(tenant_id, id);

ALTER TABLE ONLY packages
    ADD CONSTRAINT packages_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES users(id);

ALTER TABLE ONLY packages
    ADD CONSTRAINT packages_updated_by_tenant_fk FOREIGN KEY (tenant_id, updated_by) REFERENCES tenant_memberships(tenant_id, user_id);

ALTER TABLE ONLY platform_audit_events
    ADD CONSTRAINT platform_audit_events_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES users(id);

ALTER TABLE ONLY platform_audit_events
    ADD CONSTRAINT platform_audit_events_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id);

ALTER TABLE ONLY print_attempts
    ADD CONSTRAINT print_attempts_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES users(id);

ALTER TABLE ONLY print_attempts
    ADD CONSTRAINT print_attempts_actor_id_tenant_fk FOREIGN KEY (tenant_id, actor_id) REFERENCES tenant_memberships(tenant_id, user_id);

ALTER TABLE ONLY print_attempts
    ADD CONSTRAINT print_attempts_data_space_id_fkey FOREIGN KEY (data_space_id) REFERENCES data_spaces(id);

ALTER TABLE ONLY print_attempts
    ADD CONSTRAINT print_attempts_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id);

ALTER TABLE ONLY print_attempts
    ADD CONSTRAINT print_attempts_session_space_fkey FOREIGN KEY (session_id, data_space_id) REFERENCES sessions(id, data_space_id);

ALTER TABLE ONLY print_attempts
    ADD CONSTRAINT print_attempts_tenant_space_fk FOREIGN KEY (tenant_id, data_space_id) REFERENCES data_spaces(tenant_id, id);

ALTER TABLE ONLY print_attempts
    ADD CONSTRAINT print_attempts_terminal_id_fkey FOREIGN KEY (terminal_id) REFERENCES terminals(id);

ALTER TABLE ONLY print_attempts
    ADD CONSTRAINT print_attempts_terminal_id_tenant_fk FOREIGN KEY (tenant_id, terminal_id) REFERENCES terminals(tenant_id, id);

ALTER TABLE ONLY print_attempts
    ADD CONSTRAINT print_attempts_transaction_revision_fkey FOREIGN KEY (transaction_id, transaction_revision) REFERENCES transaction_revisions(transaction_id, revision);

ALTER TABLE ONLY print_attempts
    ADD CONSTRAINT print_attempts_transaction_revision_space_fkey FOREIGN KEY (transaction_id, transaction_revision, data_space_id) REFERENCES transaction_revisions(transaction_id, revision, data_space_id);

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_data_space_id_fkey FOREIGN KEY (data_space_id) REFERENCES data_spaces(id);

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_membership_tenant_fk FOREIGN KEY (membership_id, tenant_id, user_id) REFERENCES tenant_memberships(id, tenant_id, user_id);

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_space_tenant_fk FOREIGN KEY (tenant_id, data_space_id) REFERENCES data_spaces(tenant_id, id);

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id);

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_terminal_id_fkey FOREIGN KEY (terminal_id) REFERENCES terminals(id);

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_terminal_tenant_fk FOREIGN KEY (tenant_id, terminal_id) REFERENCES terminals(tenant_id, id);

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);

ALTER TABLE ONLY sync_changes
    ADD CONSTRAINT sync_changes_data_space_id_fkey FOREIGN KEY (data_space_id) REFERENCES data_spaces(id);

ALTER TABLE ONLY sync_changes
    ADD CONSTRAINT sync_changes_tenant_space_fk FOREIGN KEY (tenant_id, data_space_id) REFERENCES data_spaces(tenant_id, id);

ALTER TABLE ONLY tenant_invitations
    ADD CONSTRAINT tenant_invitations_accepted_by_fkey FOREIGN KEY (accepted_by) REFERENCES users(id);

ALTER TABLE ONLY tenant_invitations
    ADD CONSTRAINT tenant_invitations_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);

ALTER TABLE ONLY tenant_invitations
    ADD CONSTRAINT tenant_invitations_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id);

ALTER TABLE ONLY tenant_memberships
    ADD CONSTRAINT tenant_memberships_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id);

ALTER TABLE ONLY tenant_memberships
    ADD CONSTRAINT tenant_memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);

ALTER TABLE ONLY tenant_profile_revisions
    ADD CONSTRAINT tenant_profile_revisions_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);

ALTER TABLE ONLY tenant_profile_revisions
    ADD CONSTRAINT tenant_profile_revisions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id);

ALTER TABLE ONLY tenant_qris_revisions
    ADD CONSTRAINT tenant_qris_revisions_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);

ALTER TABLE ONLY tenant_qris_revisions
    ADD CONSTRAINT tenant_qris_revisions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id);

ALTER TABLE ONLY tenants
    ADD CONSTRAINT tenants_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);

ALTER TABLE ONLY tenants
    ADD CONSTRAINT tenants_profile_revision_fk FOREIGN KEY (id, profile_revision) REFERENCES tenant_profile_revisions(tenant_id, revision) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY tenants
    ADD CONSTRAINT tenants_qris_revision_fk FOREIGN KEY (id, qris_revision) REFERENCES tenant_qris_revisions(tenant_id, revision) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY terminals
    ADD CONSTRAINT terminals_enrolled_by_fkey FOREIGN KEY (enrolled_by) REFERENCES users(id);

ALTER TABLE ONLY terminals
    ADD CONSTRAINT terminals_enrolled_membership_fk FOREIGN KEY (tenant_id, enrolled_by) REFERENCES tenant_memberships(tenant_id, user_id);

ALTER TABLE ONLY terminals
    ADD CONSTRAINT terminals_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id);

ALTER TABLE ONLY transaction_items
    ADD CONSTRAINT transaction_items_data_space_id_fkey FOREIGN KEY (data_space_id) REFERENCES data_spaces(id);

ALTER TABLE ONLY transaction_items
    ADD CONSTRAINT transaction_items_package_revision_fkey FOREIGN KEY (package_id, package_revision) REFERENCES package_revisions(package_id, revision);

ALTER TABLE ONLY transaction_items
    ADD CONSTRAINT transaction_items_package_revision_space_fkey FOREIGN KEY (package_id, package_revision, data_space_id) REFERENCES package_revisions(package_id, revision, data_space_id);

ALTER TABLE ONLY transaction_items
    ADD CONSTRAINT transaction_items_tenant_space_fk FOREIGN KEY (tenant_id, data_space_id) REFERENCES data_spaces(tenant_id, id);

ALTER TABLE ONLY transaction_items
    ADD CONSTRAINT transaction_items_transaction_revision_fkey FOREIGN KEY (transaction_id, revision) REFERENCES transaction_revisions(transaction_id, revision);

ALTER TABLE ONLY transaction_items
    ADD CONSTRAINT transaction_items_transaction_revision_space_fkey FOREIGN KEY (transaction_id, revision, data_space_id) REFERENCES transaction_revisions(transaction_id, revision, data_space_id);

ALTER TABLE ONLY transaction_revisions
    ADD CONSTRAINT transaction_revisions_data_space_id_fkey FOREIGN KEY (data_space_id) REFERENCES data_spaces(id);

ALTER TABLE ONLY transaction_revisions
    ADD CONSTRAINT transaction_revisions_origin_actor_id_fkey FOREIGN KEY (origin_actor_id) REFERENCES users(id);

ALTER TABLE ONLY transaction_revisions
    ADD CONSTRAINT transaction_revisions_origin_actor_id_tenant_fk FOREIGN KEY (tenant_id, origin_actor_id) REFERENCES tenant_memberships(tenant_id, user_id);

ALTER TABLE ONLY transaction_revisions
    ADD CONSTRAINT transaction_revisions_origin_session_id_fkey FOREIGN KEY (origin_session_id) REFERENCES sessions(id);

ALTER TABLE ONLY transaction_revisions
    ADD CONSTRAINT transaction_revisions_origin_session_space_fkey FOREIGN KEY (origin_session_id, data_space_id) REFERENCES sessions(id, data_space_id);

ALTER TABLE ONLY transaction_revisions
    ADD CONSTRAINT transaction_revisions_submitted_by_actor_id_fkey FOREIGN KEY (submitted_by_actor_id) REFERENCES users(id);

ALTER TABLE ONLY transaction_revisions
    ADD CONSTRAINT transaction_revisions_submitted_by_actor_id_tenant_fk FOREIGN KEY (tenant_id, submitted_by_actor_id) REFERENCES tenant_memberships(tenant_id, user_id);

ALTER TABLE ONLY transaction_revisions
    ADD CONSTRAINT transaction_revisions_submitted_by_session_id_fkey FOREIGN KEY (submitted_by_session_id) REFERENCES sessions(id);

ALTER TABLE ONLY transaction_revisions
    ADD CONSTRAINT transaction_revisions_submitted_session_space_fkey FOREIGN KEY (submitted_by_session_id, data_space_id) REFERENCES sessions(id, data_space_id);

ALTER TABLE ONLY transaction_revisions
    ADD CONSTRAINT transaction_revisions_tenant_space_fk FOREIGN KEY (tenant_id, data_space_id) REFERENCES data_spaces(tenant_id, id);

ALTER TABLE ONLY transaction_revisions
    ADD CONSTRAINT transaction_revisions_terminal_id_fkey FOREIGN KEY (terminal_id) REFERENCES terminals(id);

ALTER TABLE ONLY transaction_revisions
    ADD CONSTRAINT transaction_revisions_terminal_id_tenant_fk FOREIGN KEY (tenant_id, terminal_id) REFERENCES terminals(tenant_id, id);

ALTER TABLE ONLY transaction_revisions
    ADD CONSTRAINT transaction_revisions_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES transactions(id);

ALTER TABLE ONLY transaction_revisions
    ADD CONSTRAINT transaction_revisions_transaction_space_fkey FOREIGN KEY (transaction_id, data_space_id) REFERENCES transactions(id, data_space_id);

ALTER TABLE ONLY transactions
    ADD CONSTRAINT transactions_current_revision_fk FOREIGN KEY (id, current_revision) REFERENCES transaction_revisions(transaction_id, revision) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY transactions
    ADD CONSTRAINT transactions_current_revision_space_fkey FOREIGN KEY (id, current_revision, data_space_id) REFERENCES transaction_revisions(transaction_id, revision, data_space_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY transactions
    ADD CONSTRAINT transactions_data_space_id_fkey FOREIGN KEY (data_space_id) REFERENCES data_spaces(id);

ALTER TABLE ONLY transactions
    ADD CONSTRAINT transactions_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES users(id);

ALTER TABLE ONLY transactions
    ADD CONSTRAINT transactions_deleted_by_tenant_fk FOREIGN KEY (tenant_id, deleted_by) REFERENCES tenant_memberships(tenant_id, user_id);

ALTER TABLE ONLY transactions
    ADD CONSTRAINT transactions_origin_actor_id_fkey FOREIGN KEY (origin_actor_id) REFERENCES users(id);

ALTER TABLE ONLY transactions
    ADD CONSTRAINT transactions_origin_actor_id_tenant_fk FOREIGN KEY (tenant_id, origin_actor_id) REFERENCES tenant_memberships(tenant_id, user_id);

ALTER TABLE ONLY transactions
    ADD CONSTRAINT transactions_origin_session_id_fkey FOREIGN KEY (origin_session_id) REFERENCES sessions(id);

ALTER TABLE ONLY transactions
    ADD CONSTRAINT transactions_origin_session_space_fkey FOREIGN KEY (origin_session_id, data_space_id) REFERENCES sessions(id, data_space_id);

ALTER TABLE ONLY transactions
    ADD CONSTRAINT transactions_receipt_profile_fk FOREIGN KEY (tenant_id, receipt_profile_revision) REFERENCES tenant_profile_revisions(tenant_id, revision);

ALTER TABLE ONLY transactions
    ADD CONSTRAINT transactions_tenant_space_fk FOREIGN KEY (tenant_id, data_space_id) REFERENCES data_spaces(tenant_id, id);

ALTER TABLE ONLY transactions
    ADD CONSTRAINT transactions_terminal_id_fkey FOREIGN KEY (terminal_id) REFERENCES terminals(id);

ALTER TABLE ONLY transactions
    ADD CONSTRAINT transactions_terminal_id_tenant_fk FOREIGN KEY (tenant_id, terminal_id) REFERENCES terminals(tenant_id, id);

ALTER TABLE ONLY transactions
    ADD CONSTRAINT transactions_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES users(id);

ALTER TABLE ONLY transactions
    ADD CONSTRAINT transactions_updated_by_tenant_fk FOREIGN KEY (tenant_id, updated_by) REFERENCES tenant_memberships(tenant_id, user_id);
