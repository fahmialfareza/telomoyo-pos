package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/domain"
	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/port"
	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/usecase"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/newrelic/go-agent/v3/newrelic"
	"github.com/sirupsen/logrus"
)

type healthRepository struct {
	port.Repository
}

type syncViewRepository struct {
	port.Repository
}

type transactionViewRepository struct {
	port.Repository
}

type sessionViewRepository struct {
	port.Repository
}

type retiredRecoveryRepository struct {
	port.Repository
	retired   domain.Principal
	active    domain.DataSpace
	recovered domain.Principal
	called    bool
}

type unavailableAuthRepository struct{ port.Repository }

func (unavailableAuthRepository) PrincipalByTokenHash(context.Context, []byte) (domain.Principal, error) {
	return domain.Principal{}, domain.WrapInternal(errors.New("database waking"), "find session token")
}

func (repository *retiredRecoveryRepository) PrincipalByTokenHash(context.Context, []byte) (domain.Principal, error) {
	return repository.retired, domain.NewError(
		domain.CodeSandboxGenerationRetired,
		"Generasi Sandbox telah diganti",
	)
}

func (repository *retiredRecoveryRepository) ActiveDataSpace(context.Context, uuid.UUID, domain.DataMode) (domain.DataSpace, error) {
	return repository.active, nil
}

func (repository *retiredRecoveryRepository) RecoverRetiredSandboxSession(
	context.Context,
	domain.Principal,
	[]byte,
	[]byte,
	uuid.UUID,
) (domain.Principal, error) {
	repository.called = true
	return repository.recovered, nil
}

func (repository *retiredRecoveryRepository) GetUser(context.Context, uuid.UUID, uuid.UUID) (domain.User, error) {
	return domain.User{
		ID: repository.retired.UserID, FullName: "Admin Recovery",
		Username: "admin.recovery", Role: domain.RoleAdmin, IsActive: true,
	}, nil
}

type retiredRecoveryTokens struct{}

func (retiredRecoveryTokens) New() (string, []byte, error) {
	return "replacement-token", []byte("replacement-hash"), nil
}

func (retiredRecoveryTokens) Hash(string) ([]byte, error) {
	return []byte("retired-hash"), nil
}

type retiredRecoverySessionIndex struct {
	values map[string]uuid.UUID
}

func (index *retiredRecoverySessionIndex) Get(_ context.Context, hash []byte) (uuid.UUID, bool) {
	id, ok := index.values[string(hash)]
	return id, ok
}

func (index *retiredRecoverySessionIndex) Set(_ context.Context, hash []byte, sessionID uuid.UUID) {
	index.values[string(hash)] = sessionID
}

func (index *retiredRecoverySessionIndex) Delete(_ context.Context, hash []byte) {
	delete(index.values, string(hash))
}

func (transactionViewRepository) ListPrintAttempts(context.Context, uuid.UUID, string) ([]domain.PrintAttempt, error) {
	return nil, nil
}

func (syncViewRepository) GetPackage(context.Context, uuid.UUID, uuid.UUID) (domain.Package, error) {
	return domain.Package{
		ID:   uuid.MustParse("00000000-0000-4000-8000-000000000001"),
		Code: "STANDARD", CurrentRevision: 3, Name: "Paket Standar",
		Description: "Deskripsi", UnitPrice: 80_000,
		CreatedAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		UpdatedAt: time.Date(2026, 7, 24, 0, 0, 0, 0, time.UTC),
	}, nil
}

func (sessionViewRepository) GetUser(context.Context, uuid.UUID, uuid.UUID) (domain.User, error) {
	return domain.User{
		ID:       uuid.MustParse("00000000-0000-4000-8000-000000000010"),
		FullName: "Admin Uji", Username: "admin.uji", Role: domain.RoleAdmin, IsActive: true,
	}, nil
}

func TestSyncPackagePayloadUsesPublicDTO(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/api/v1/sync/pull", nil)
	contextRecorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(contextRecorder)
	c.Request = request
	server := &Server{deps: Dependencies{Repo: syncViewRepository{}}}
	payload, err := server.syncChangePayload(c, domain.SyncChange{
		Aggregate: "package", AggregateID: "00000000-0000-4000-8000-000000000001",
	})
	if err != nil {
		t.Fatal(err)
	}
	view, ok := payload.(gin.H)
	if !ok {
		t.Fatalf("payload has type %T", payload)
	}
	if _, ok := view["currentRevision"].(gin.H); !ok {
		t.Fatalf("public currentRevision missing: %+v", view)
	}
	if _, leaked := view["revision"]; leaked {
		t.Fatalf("internal revision leaked: %+v", view)
	}
}

func TestTransactionViewIncludesPaymentConfirmation(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/api/v1/transactions/example", nil)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = request
	server := &Server{deps: Dependencies{Repo: transactionViewRepository{}}}
	confirmedRevision := 2
	qrisPayloadHash := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	occurredAt := time.Date(
		2026, 7, 29, 18, 0, 0, 0,
		time.FixedZone("WIB", 7*60*60),
	)

	view, err := server.transactionView(c, domain.Transaction{
		ID: "01ARZ3NDEKTSV4RRFFQ69G5FAV", DisplayID: "TEST-TRX-01ARZ3NDEKTSV4RRFFQ69G5FAV", Revision: 2,
		OccurredAt:               occurredAt,
		Total:                    80_000,
		PaymentAmount:            1_000,
		PaymentMethod:            domain.PaymentMethodQRIS,
		QrisPayloadHash:          &qrisPayloadHash,
		PaymentStatus:            domain.PaymentStatusSuccess,
		PaymentConfirmedRevision: &confirmedRevision,
		Items:                    []domain.TransactionItem{},
	})
	if err != nil {
		t.Fatal(err)
	}
	if view["paymentMethod"] != domain.PaymentMethodQRIS ||
		view["displayId"] != "TEST-TRX-01ARZ3NDEKTSV4RRFFQ69G5FAV" ||
		view["paymentAmount"] != int64(1_000) ||
		view["qrisPayloadHash"] != qrisPayloadHash ||
		view["paymentStatus"] != domain.PaymentStatusSuccess ||
		view["paymentConfirmedRevision"] != &confirmedRevision {
		t.Fatalf("payment fields missing from transaction view: %+v", view)
	}
	if got, ok := view["occurredAt"].(time.Time); !ok ||
		got.Location() != time.UTC ||
		!got.Equal(occurredAt) {
		t.Fatalf("occurredAt was not serialized in UTC: %#v", view["occurredAt"])
	}
}

func TestSessionViewIncludesImmutableDataBoundary(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/api/v1/profile", nil)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = request
	spaceID := uuid.MustParse("00000000-0000-4000-8000-000000000777")
	current := domain.Principal{
		ContextKind: domain.ContextTenant, TenantID: domain.InitialTenantID(), MembershipID: uuid.New(),
		UserID:      uuid.MustParse("00000000-0000-4000-8000-000000000010"),
		SessionID:   uuid.MustParse("00000000-0000-4000-8000-000000000020"),
		DataSpaceID: spaceID, DataMode: domain.DataModeSandbox, SandboxGeneration: 7,
	}
	server := &Server{deps: Dependencies{Repo: sessionViewRepository{}}}

	view, err := server.sessionView(c, current)
	if err != nil {
		t.Fatal(err)
	}
	if view["dataMode"] != domain.DataModeSandbox ||
		view["dataSpaceId"] != spaceID ||
		view["sandboxGeneration"] != int64(7) {
		t.Fatalf("session boundary missing: %+v", view)
	}
}

func TestRetiredSandboxIdentityCanOnlyReachSwitchModeRecovery(t *testing.T) {
	gin.SetMode(gin.TestMode)
	oldSpaceID := uuid.MustParse("00000000-0000-4000-8000-000000000701")
	activeSpaceID := uuid.MustParse("00000000-0000-4000-8000-000000000702")
	retired := domain.Principal{
		ContextKind: domain.ContextTenant, TenantID: domain.InitialTenantID(), MembershipID: uuid.New(),
		UserID:    uuid.MustParse("00000000-0000-4000-8000-000000000710"),
		SessionID: uuid.MustParse("00000000-0000-4000-8000-000000000711"),
		FullName:  "Admin Recovery", Username: "admin.recovery", Role: domain.RoleAdmin,
		DataSpaceID: oldSpaceID, DataMode: domain.DataModeSandbox, SandboxGeneration: 7,
	}
	recovered := retired
	recovered.SessionID = uuid.MustParse("00000000-0000-4000-8000-000000000712")
	recovered.DataSpaceID = activeSpaceID
	recovered.SandboxGeneration = 8
	repository := &retiredRecoveryRepository{
		retired: retired,
		active: domain.DataSpace{
			ID: activeSpaceID, Mode: domain.DataModeSandbox,
			Generation: 8, Status: domain.DataSpaceStatusActive,
		},
		recovered: recovered,
	}
	index := &retiredRecoverySessionIndex{values: map[string]uuid.UUID{}}
	router := New(Dependencies{
		Repo: repository,
		Auth: usecase.Auth{
			Repo: repository, Tokens: retiredRecoveryTokens{}, Sessions: index,
			SandboxEnabled: true,
		},
	})

	switchRequest := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/auth/switch-mode",
		strings.NewReader(`{"mode":"sandbox"}`),
	)
	switchRequest.Header.Set("Authorization", "Bearer retired-token")
	switchRequest.Header.Set("Content-Type", "application/json")
	switchResponse := httptest.NewRecorder()
	router.ServeHTTP(switchResponse, switchRequest)
	if switchResponse.Code != http.StatusOK || !repository.called {
		t.Fatalf("switch recovery status=%d called=%v body=%s", switchResponse.Code, repository.called, switchResponse.Body.String())
	}
	var switchEnvelope struct {
		Data struct {
			SessionToken      string          `json:"sessionToken"`
			DataMode          domain.DataMode `json:"dataMode"`
			DataSpaceID       uuid.UUID       `json:"dataSpaceId"`
			SandboxGeneration int64           `json:"sandboxGeneration"`
		} `json:"data"`
	}
	if err := json.Unmarshal(switchResponse.Body.Bytes(), &switchEnvelope); err != nil {
		t.Fatal(err)
	}
	if switchEnvelope.Data.SessionToken != "replacement-token" ||
		switchEnvelope.Data.DataMode != domain.DataModeSandbox ||
		switchEnvelope.Data.DataSpaceID != activeSpaceID ||
		switchEnvelope.Data.SandboxGeneration != 8 {
		t.Fatalf("switch recovery response = %+v", switchEnvelope.Data)
	}

	// The same retired credential is not admitted to any other protected route.
	profileRequest := httptest.NewRequest(http.MethodGet, "/api/v1/profile", nil)
	profileRequest.Header.Set("Authorization", "Bearer retired-token")
	profileResponse := httptest.NewRecorder()
	router.ServeHTTP(profileResponse, profileRequest)
	if profileResponse.Code != http.StatusConflict {
		t.Fatalf("retired profile status=%d body=%s", profileResponse.Code, profileResponse.Body.String())
	}
	var errorEnvelope struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(profileResponse.Body.Bytes(), &errorEnvelope); err != nil {
		t.Fatal(err)
	}
	if errorEnvelope.Error.Code != domain.CodeSandboxGenerationRetired {
		t.Fatalf("retired profile error = %q", errorEnvelope.Error.Code)
	}
}

func TestDatabaseWakeFailureIsNotSerializedAsUnauthorized(t *testing.T) {
	gin.SetMode(gin.TestMode)
	repository := unavailableAuthRepository{}
	router := New(Dependencies{
		Repo: repository,
		Auth: usecase.Auth{
			Repo: repository, Tokens: retiredRecoveryTokens{},
			Sessions: &retiredRecoverySessionIndex{values: map[string]uuid.UUID{}},
		},
	})
	request := httptest.NewRequest(http.MethodGet, "/api/v1/profile", nil)
	request.Header.Set("Authorization", "Bearer valid-token")
	response := httptest.NewRecorder()

	router.ServeHTTP(response, request)

	if response.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var envelope struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Error.Code != domain.CodeInternal {
		t.Fatalf("error code=%q, want %q", envelope.Error.Code, domain.CodeInternal)
	}
}

func TestSandboxExportFilenameIsPermanentlyMarked(t *testing.T) {
	now := time.Date(2026, 9, 5, 8, 9, 10, 0, time.UTC)
	if got := transactionExportFilename(domain.Principal{
		DataMode: domain.DataModeSandbox,
	}, "pdf", now); got != "TEST-transaksi-20260905-080910.pdf" {
		t.Fatalf("sandbox filename = %q", got)
	}
	if got := transactionExportFilename(domain.Principal{
		DataMode: domain.DataModeProduction,
	}, "xlsx", now); got != "transaksi-20260905-080910.xlsx" {
		t.Fatalf("production filename = %q", got)
	}
}

func TestProductionGuardRejectsSharedMutationsFromSandbox(t *testing.T) {
	request := httptest.NewRequest(http.MethodPost, "/api/v1/profile/password", nil)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = request
	c.Set(principalKey, domain.Principal{ContextKind: domain.ContextTenant, TenantID: domain.InitialTenantID(), MembershipID: uuid.New(), DataSpaceID: uuid.New(), DataMode: domain.DataModeSandbox})

	(&Server{}).requireProduction()(c)
	if !c.IsAborted() || recorder.Code != http.StatusForbidden {
		t.Fatalf("aborted=%v status=%d body=%s", c.IsAborted(), recorder.Code, recorder.Body.String())
	}
	var envelope struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Error.Code != domain.CodeForbidden {
		t.Fatalf("error code = %q", envelope.Error.Code)
	}
}

func TestRevisionConflictNormalizesLegacyIdempotencySnapshots(t *testing.T) {
	t.Parallel()

	legacySnapshot := map[string]any{
		"occurredAt": "2026-01-01T00:00:00Z",
		"items":      []any{},
		"subtotal":   0,
		"total":      0,
	}
	normalized := normalizeRevisionConflictDetails(map[string]any{
		"baseRevision":    2,
		"currentRevision": 4,
		"localSnapshot":   legacySnapshot,
		"serverSnapshot":  legacySnapshot,
	})
	details, ok := normalized.(map[string]any)
	if !ok {
		t.Fatalf("normalized details have type %T", normalized)
	}
	for name, revision := range map[string]float64{
		"localSnapshot":  3,
		"serverSnapshot": 4,
	} {
		snapshot, ok := details[name].(map[string]any)
		if !ok {
			t.Fatalf("%s has type %T", name, details[name])
		}
		if snapshot["paymentMethod"] != string(domain.PaymentMethodLegacy) ||
			snapshot["paymentStatus"] != string(domain.PaymentStatusSuccess) ||
			snapshot["paymentConfirmedRevision"] != revision {
			t.Fatalf("%s was not normalized: %+v", name, snapshot)
		}
	}
}

func (healthRepository) Ping(context.Context) error { return nil }

func TestLivenessEnvelopeAndRequestID(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := New(Dependencies{Repo: healthRepository{}})
	request := httptest.NewRequest(http.MethodGet, "/api/v1/health/live", nil)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body)
	}
	if _, err := uuid.Parse(recorder.Header().Get("X-Request-Id")); err != nil {
		t.Fatalf("invalid request ID: %v", err)
	}
	var envelope struct {
		Data struct {
			Status   string `json:"status"`
			Postgres string `json:"postgres"`
			Redis    string `json:"redis"`
		} `json:"data"`
		Meta map[string]any `json:"meta"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Data.Status != "ok" || envelope.Data.Postgres != "ok" || envelope.Data.Redis != "unavailable" {
		t.Fatalf("unexpected health envelope: %+v", envelope.Data)
	}
	if envelope.Meta["requestId"] == nil || envelope.Meta["serverTime"] == nil {
		t.Fatalf("missing metadata: %+v", envelope.Meta)
	}
}

func TestPublicWebRequestLogHasFailClosedProductionScope(t *testing.T) {
	gin.SetMode(gin.TestMode)
	app, err := newrelic.NewApplication(
		newrelic.ConfigEnabled(false),
		newrelic.ConfigAppName("http-scope-test"),
	)
	if err != nil {
		t.Fatal(err)
	}
	defer app.Shutdown(time.Second)

	var output bytes.Buffer
	logger := logrus.New()
	logger.SetOutput(&output)
	logger.SetFormatter(&logrus.JSONFormatter{})
	router := New(Dependencies{
		Repo: healthRepository{}, Logger: logger, NewRelic: app,
	})
	request := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)

	log := output.String()
	for _, field := range []string{
		`"auth.context":"public"`,
	} {
		if !strings.Contains(log, field) {
			t.Fatalf("public request log does not contain %s: %s", field, log)
		}
	}
	if strings.Contains(log, `"tenant.id"`) || strings.Contains(log, `"data.space_id"`) {
		t.Fatalf("public request invented business scope: %s", log)
	}
}
