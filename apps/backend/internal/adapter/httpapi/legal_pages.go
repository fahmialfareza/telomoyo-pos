package httpapi

import (
	"bytes"
	"context"
	"embed"
	"html/template"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/observability"
	"github.com/gin-gonic/gin"
)

// Templates and styling are compiled into the API, including distroless builds.
//
//go:embed pages/*.html pages/styles.css
var legalPageFiles embed.FS

var legalPageTemplates = template.Must(template.ParseFS(legalPageFiles, "pages/*.html"))

type LegalPageOptions struct {
	OperatorName         string
	ContactEmail         string
	SandboxRetentionDays int
}

type legalPageView struct {
	LegalPageOptions
	Title           string
	Description     string
	IsDeletion      bool
	Available       bool
	PrivacyMailURL  string
	DeletionMailURL string
}

func (s *Server) privacyPolicy(c *gin.Context) {
	defer observability.StartSegment(c.Request.Context(), "HTTP.PrivacyPolicy")()
	s.renderLegalPage(c, false)
}

func (s *Server) accountDeletion(c *gin.Context) {
	defer observability.StartSegment(c.Request.Context(), "HTTP.AccountDeletion")()
	s.renderLegalPage(c, true)
}

func (s *Server) renderLegalPage(c *gin.Context, deletion bool) {
	defer observability.StartSegment(c.Request.Context(), "HTTP.RenderLegalPage")()
	options := s.deps.LegalPages
	options.OperatorName = strings.TrimSpace(options.OperatorName)
	options.ContactEmail = strings.TrimSpace(options.ContactEmail)
	if options.OperatorName == "" {
		options.OperatorName = "Pengelola Wisata Telomoyo"
	}
	if options.SandboxRetentionDays < 1 {
		options.SandboxRetentionDays = 30
	}
	view := legalPageView{
		LegalPageOptions: options,
		Title:            "Kebijakan Privasi",
		Description:      "Kebijakan Privasi Telomoyo POS: data yang diproses, penggunaannya, penyimpanan, dan kontak pengelola.",
		IsDeletion:       deletion,
		Available:        options.ContactEmail != "",
	}
	if deletion {
		view.Title = "Penghapusan Akun & Data"
		view.Description = "Cara meminta penghapusan akun Telomoyo POS dan data terkait melalui pengelola, tanpa perlu masuk ke aplikasi."
	}
	if view.Available {
		view.PrivacyMailURL = legalContactURL(c.Request.Context(), options.ContactEmail, "Pertanyaan privasi Telomoyo POS")
		view.DeletionMailURL = legalContactURL(c.Request.Context(), options.ContactEmail, "Permintaan penghapusan akun dan data Telomoyo POS")
	}

	legalPageHeaders(c)
	c.Header("Cache-Control", "no-store")
	c.Header("Content-Language", "id")
	status := http.StatusOK
	if !view.Available {
		// Keep the API operational, but do not present an incomplete policy or
		// an unusable deletion request mechanism as a publishable document.
		status = http.StatusServiceUnavailable
		c.Header("X-Robots-Tag", "noindex")
	}
	var body bytes.Buffer
	if err := legalPageTemplates.ExecuteTemplate(&body, "layout", view); err != nil {
		observability.NoticeError(c.Request.Context(), err, "http.render_legal_page")
		c.Header("X-Robots-Tag", "noindex")
		writeLegalResponse(c, http.StatusInternalServerError, "text/plain; charset=utf-8", []byte("Halaman belum dapat ditampilkan. Silakan coba lagi nanti."))
		return
	}
	writeLegalResponse(c, status, "text/html; charset=utf-8", body.Bytes())
}

func (s *Server) legalStyles(c *gin.Context) {
	defer observability.StartSegment(c.Request.Context(), "HTTP.LegalStyles")()
	legalPageHeaders(c)
	c.Header("Cache-Control", "public, max-age=3600")
	css, err := legalPageFiles.ReadFile("pages/styles.css")
	if err != nil {
		observability.NoticeError(c.Request.Context(), err, "http.legal_styles")
		writeLegalResponse(c, http.StatusInternalServerError, "text/plain; charset=utf-8", []byte("Stylesheet unavailable"))
		return
	}
	writeLegalResponse(c, http.StatusOK, "text/css; charset=utf-8", css)
}

func legalPageHeaders(c *gin.Context) {
	defer observability.StartSegment(c.Request.Context(), "HTTP.LegalPageHeaders")()
	c.Header("Content-Security-Policy", "default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
	c.Header("X-Content-Type-Options", "nosniff")
	c.Header("X-Frame-Options", "DENY")
	c.Header("Referrer-Policy", "no-referrer")
	c.Header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
}

func writeLegalResponse(c *gin.Context, status int, contentType string, body []byte) {
	defer observability.StartSegment(c.Request.Context(), "HTTP.WriteLegalResponse")()
	c.Header("Content-Type", contentType)
	c.Header("Content-Length", strconv.Itoa(len(body)))
	if c.Request.Method == http.MethodHead {
		c.Status(status)
		return
	}
	c.Data(status, contentType, body)
}

func legalContactURL(ctx context.Context, email, subject string) string {
	defer observability.StartSegment(ctx, "HTTP.LegalContactURL")()
	// Encode mail headers separately from the address; html/template also
	// escapes the result when inserting it into an href attribute.
	return (&url.URL{
		Scheme: "mailto", Opaque: email,
		RawQuery: url.Values{"subject": {subject}}.Encode(),
	}).String()
}
