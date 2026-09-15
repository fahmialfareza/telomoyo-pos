package httpapi

import (
	"html"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func legalTestRouter(email string) *gin.Engine {
	gin.SetMode(gin.TestMode)
	// Deliberately no repository, Redis, session service, or New Relic agent:
	// public pages must not depend on any authenticated business operation.
	return New(Dependencies{LegalPages: LegalPageOptions{
		OperatorName:         "Pengelola Wisata Telomoyo",
		ContactEmail:         email,
		SandboxRetentionDays: 45,
	}})
}

func TestLegalPagesArePublicHTMLWithoutBusinessDependencies(t *testing.T) {
	router := legalTestRouter("privasi@example.org")
	for _, path := range []string{"/privacy-policy", "/account-deletion"} {
		for _, token := range []string{"", "Bearer revoked-token"} {
			t.Run(path+"/"+token, func(t *testing.T) {
				request := httptest.NewRequest(http.MethodGet, path, nil)
				request.Header.Set("Authorization", token)
				recorder := httptest.NewRecorder()
				router.ServeHTTP(recorder, request)
				if recorder.Code != http.StatusOK {
					t.Fatalf("GET %s = %d: %s", path, recorder.Code, recorder.Body.String())
				}
				for _, text := range []string{
					"<!doctype html>", `<html lang="id">`, "Telomoyo POS",
					"Pengelola Wisata Telomoyo", "privasi@example.org", "45 hari",
					`href="/privacy-policy"`, `href="/account-deletion"`,
				} {
					if !strings.Contains(recorder.Body.String(), text) {
						t.Errorf("%s missing %q", path, text)
					}
				}
				if recorder.Header().Get("Content-Type") != "text/html; charset=utf-8" ||
					recorder.Header().Get("Content-Language") != "id" {
					t.Fatalf("unexpected content headers: %v", recorder.Header())
				}
				if recorder.Header().Get("X-Robots-Tag") != "" || recorder.Header().Get("Set-Cookie") != "" {
					t.Fatal("published public pages must not set cookies or block indexing")
				}
			})
		}
	}
}

func TestLegalPagesSecurityAndHead(t *testing.T) {
	router := legalTestRouter("privasi@example.org")
	for _, path := range []string{"/privacy-policy", "/account-deletion", "/legal/styles.css"} {
		get := httptest.NewRecorder()
		router.ServeHTTP(get, httptest.NewRequest(http.MethodGet, path, nil))
		head := httptest.NewRecorder()
		router.ServeHTTP(head, httptest.NewRequest(http.MethodHead, path, nil))
		if get.Code != http.StatusOK || head.Code != http.StatusOK || head.Body.Len() != 0 {
			t.Fatalf("%s: GET=%d HEAD=%d body=%d", path, get.Code, head.Code, head.Body.Len())
		}
		for key, value := range map[string]string{
			"Content-Security-Policy": "default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
			"X-Content-Type-Options":  "nosniff",
			"X-Frame-Options":         "DENY",
			"Referrer-Policy":         "no-referrer",
			"Content-Length":          strconv.Itoa(get.Body.Len()),
		} {
			if get.Header().Get(key) != value || head.Header().Get(key) != value {
				t.Errorf("%s: %s GET=%q HEAD=%q, want %q", path, key, get.Header().Get(key), head.Header().Get(key), value)
			}
		}
		if path == "/legal/styles.css" {
			if get.Header().Get("Content-Type") != "text/css; charset=utf-8" || !strings.Contains(get.Body.String(), "@media (max-width: 600px)") {
				t.Fatal("embedded responsive stylesheet not served")
			}
		} else if get.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("legal policy changes must not be hidden by a cached page")
		}
	}
}

func TestLegalPagesRequireAConfiguredContactWithoutDisruptingLiveness(t *testing.T) {
	router := legalTestRouter("")
	for _, path := range []string{"/privacy-policy", "/account-deletion"} {
		for _, method := range []string{http.MethodGet, http.MethodHead} {
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, httptest.NewRequest(method, path, nil))
			if recorder.Code != http.StatusServiceUnavailable || recorder.Header().Get("X-Robots-Tag") != "noindex" {
				t.Fatalf("missing contact must not publish a usable policy: %d", recorder.Code)
			}
			if method == http.MethodGet && !strings.Contains(recorder.Body.String(), "Informasi kontak sedang disiapkan") {
				t.Fatal("missing helpful setup message")
			}
			if strings.Contains(recorder.Body.String(), "mailto:") || strings.Contains(recorder.Body.String(), "@example") {
				t.Fatal("must not publish a non-working or placeholder request link")
			}
		}
	}
	live := httptest.NewRecorder()
	router.ServeHTTP(live, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if live.Code != http.StatusOK {
		t.Fatalf("missing legal contact broke liveness: %d", live.Code)
	}
}

func TestLegalPageEscapesOperatorAndOffersEncodedEmailRequests(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := New(Dependencies{LegalPages: LegalPageOptions{
		OperatorName: `<script>alert("operator")</script>`,
		ContactEmail: "privacy+telomoyo@example.org",
	}})
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/account-deletion?email=untrusted@example.org", nil))
	body := recorder.Body.String()
	if strings.Contains(body, "<script>") || !strings.Contains(body, "&lt;script&gt;") || strings.Contains(body, "untrusted@example.org") {
		t.Fatal("page must escape configured text and ignore request-supplied identity")
	}
	match := regexp.MustCompile(`href="(mailto:[^"]+)"`).FindStringSubmatch(body)
	if len(match) != 2 {
		t.Fatal("no usable email request link")
	}
	parsed, err := url.Parse(html.UnescapeString(match[1]))
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Opaque != "privacy+telomoyo@example.org" || parsed.Query().Get("subject") != "Permintaan penghapusan akun dan data Telomoyo POS" {
		t.Fatalf("invalid deletion email link: %s", parsed)
	}
	for _, required := range []string{"jalur permintaan manual", "Penonaktifan bukan penghapusan", "perkiraan waktu penyelesaian", "cadangan"} {
		if !strings.Contains(body, required) {
			t.Errorf("deletion page missing limitation %q", required)
		}
	}
}

func TestLegalPagesDoNotIntroduceExternalResourcesOrMutationRoutes(t *testing.T) {
	router := legalTestRouter("privasi@example.org")
	for _, path := range []string{"/privacy-policy", "/account-deletion"} {
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
		for _, forbidden := range []string{"<script", "<iframe", "<form", "https://", "http://"} {
			if strings.Contains(recorder.Body.String(), forbidden) {
				t.Errorf("unexpected active or third-party content %q on %s", forbidden, path)
			}
		}
		for _, method := range []string{http.MethodPost, http.MethodDelete, http.MethodPut} {
			response := httptest.NewRecorder()
			router.ServeHTTP(response, httptest.NewRequest(method, path, nil))
			if response.Code != http.StatusNotFound {
				t.Errorf("public pages must not handle %s: got %d", method, response.Code)
			}
		}
	}
	for _, path := range []string{"/legal/privacy.html", "/legal/../.env", "/legal/pages/layout.html"} {
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
		if recorder.Code != http.StatusNotFound {
			t.Errorf("static directory must not be exposed: %s = %d", path, recorder.Code)
		}
	}
}
