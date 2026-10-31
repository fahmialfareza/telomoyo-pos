package httpapi

import (
	"compress/gzip"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestSuccessfulResponsesAreGzippedWhenClientAcceptsIt(t *testing.T) {
	router := legalTestRouter("privasi@example.com")
	request := httptest.NewRequest(http.MethodGet, "/privacy-policy", nil)
	request.Header.Set("Accept-Encoding", "gzip")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d", recorder.Code)
	}
	if got := recorder.Header().Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("Content-Encoding=%q, want gzip", got)
	}
	if got := recorder.Header().Get("Vary"); !strings.Contains(got, "Accept-Encoding") {
		t.Fatalf("Vary=%q, want Accept-Encoding", got)
	}
	reader, err := gzip.NewReader(recorder.Body)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), "privasi@example.com") {
		t.Fatalf("decompressed body missing page content: %s", body)
	}
}

func TestResponsesStayPlainWithoutAcceptEncoding(t *testing.T) {
	router := legalTestRouter("privasi@example.com")
	request := httptest.NewRequest(http.MethodGet, "/privacy-policy", nil)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)

	if got := recorder.Header().Get("Content-Encoding"); got != "" {
		t.Fatalf("Content-Encoding=%q, want none", got)
	}
	if !strings.Contains(recorder.Body.String(), "privasi@example.com") {
		t.Fatalf("plain body missing page content")
	}
}

func TestHealthProbesAndErrorEnvelopesAreNotGzipped(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := New(Dependencies{Repo: healthRepository{}})

	// Health probes are excluded explicitly; error envelopes (4xx/5xx) are left
	// uncompressed by the middleware so clients can always parse them.
	for _, path := range []string{"/api/v1/health/live", "/api/v1/profile"} {
		request := httptest.NewRequest(http.MethodGet, path, nil)
		request.Header.Set("Accept-Encoding", "gzip")
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)

		if got := recorder.Header().Get("Content-Encoding"); got != "" {
			t.Fatalf("%s: Content-Encoding=%q, want none", path, got)
		}
		if !json.Valid(recorder.Body.Bytes()) {
			t.Fatalf("%s: body is not JSON: %s", path, recorder.Body)
		}
	}
}
