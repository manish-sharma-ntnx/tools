// Package config holds the controllers, discovery rules, and runtime settings.
// Ported from server/config.js. Jenkins controllers are read-only (anonymous).
// Controllers: devtest, sbprod, sbprod1, sbprod3, sbprod4 (SB prod),
// harbinger (prod-14, legacy LKG), harbinger12 (prod-12, older precommit PC).
// Current patch Precommit + Local LCC live on sbprod4; LKG master uses sbprod1.
package config

import (
	"net"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Controller is one Jenkins controller (read-only, anonymous JSON API).
type Controller struct {
	ID       string
	Label    string
	BaseURL  string
	Insecure bool // internal self-signed cert → skip TLS verify
}

// Controllers keyed by id (matches the Node CONTROLLERS map).
var Controllers = map[string]Controller{
	"devtest":     {ID: "devtest", Label: "Devtest", BaseURL: "http://10.37.10.188:8080", Insecure: false},
	"sbprod1":     {ID: "sbprod1", Label: "SB Prod Controller-1", BaseURL: "https://phx-p10y-sb-prod-jenkins-controller-1.corp.p10y.ntnxdpro.com", Insecure: true},
	"sbprod":      {ID: "sbprod", Label: "SB Prod Controller-2", BaseURL: "https://phx-p10y-sb-prod-jenkins-controller-2.corp.p10y.ntnxdpro.com", Insecure: true},
	"harbinger":   {ID: "harbinger", Label: "Harbinger Prod-14", BaseURL: "https://phx-p10y-jenkins-harbinger-prod-14.p10y.eng.nutanix.com", Insecure: true},
	"harbinger12": {ID: "harbinger12", Label: "Harbinger Prod-12", BaseURL: "https://phx-p10y-jenkins-harbinger-prod-12.p10y.eng.nutanix.com", Insecure: true},
	"sbprod3":     {ID: "sbprod3", Label: "SB Prod Controller-3", BaseURL: "https://phx-p10y-sb-prod-jenkins-controller-3.corp.p10y.ntnxdpro.com", Insecure: true},
	"sbprod4":     {ID: "sbprod4", Label: "SB Prod Controller-4", BaseURL: "https://phx-p10y-sb-prod-jenkins-controller-4.corp.p10y.ntnxdpro.com", Insecure: true},
}

// StaticPipeline is an always-present, non-version-scoped pipeline.
type StaticPipeline struct {
	Key        string
	Controller string
	Path       []string
	Group      string
	Category   string
	Title      string
	Subtitle   string
}

var StaticPipelines = []StaticPipeline{
	{
		Key:        "devtest-precommit",
		Controller: "devtest",
		Path:       []string{"msp-controller-precommit"},
		Group:      "Devtest",
		Category:   "devtest",
		Title:      "Devtest Precommit",
		Subtitle:   "msp-controller-precommit",
	},
}

// DiscoveryRule describes how to auto-find version-scoped pipelines in a folder.
type DiscoveryRule struct {
	ID           string
	Controller   string
	Parent       []string
	Label        string
	ShortLabel   string
	Lane         string
	MasterGroup  string
	MasterName   string // "" means the lane has no real master job
	VersionRegex *regexp.Regexp
	JobPrefix    string
	JobSuffix    string
}

// DiscoveryRules mirrors the Node DISCOVERY_RULES array (order preserved).
var DiscoveryRules = []DiscoveryRule{
	{
		// Master Local LCC + older patch (e.g. 7.6). Current trains (7.6.1,
		// 7.7, …) live on Controller-4 (lcc-local-c4) and upsert over this.
		ID: "lcc-local", Controller: "sbprod", Parent: []string{"Nupipe", "LCC_NOS"},
		Label: "msp_master Local LCC", ShortLabel: "Local LCC", Lane: "LCC",
		MasterGroup: "msp-master", MasterName: "msp-master",
		VersionRegex: regexp.MustCompile(`^msp-ganges-(\d+(?:\.\d+)*)$`), JobPrefix: "msp-ganges-",
	},
	{
		ID: "glcc", Controller: "sbprod", Parent: []string{"Nupipe", "LCC_Dial_Tests"},
		Label: "msp_master GLCC", ShortLabel: "GLCC", Lane: "GLCC",
		MasterGroup: "msp-master", MasterName: "msp-master",
		VersionRegex: regexp.MustCompile(`^msp-ganges-(\d+(?:\.\d+)*)$`), JobPrefix: "msp-ganges-",
	},
	{
		ID: "precommit-master", Controller: "sbprod3", Parent: []string{"Nupipe", "Precommit_NOS"},
		Label: "msp Precommit", ShortLabel: "Precommit", Lane: "Precommit",
		MasterGroup: "msp-master", MasterName: "msp-master",
		// No version-scoped jobs consumed here; master only. Regex never matches.
		VersionRegex: regexp.MustCompile(`^$`),
	},
	{
		// Older patch Precommit PC (7.6, 7.6.0.x, 7.6.9.1–3). Current trains
		// moved to sbprod4; listed first so the later rule wins overlaps.
		ID: "precommit-pc", Controller: "harbinger12", Parent: []string{"Nupipe", "Precommit_PC"},
		Label: "msp Precommit PC", ShortLabel: "Precommit", Lane: "Precommit",
		MasterName:   "",
		VersionRegex: regexp.MustCompile(`^msp-ganges-(\d+(?:\.\d+)*)-pc$`), JobPrefix: "msp-ganges-", JobSuffix: "-pc",
	},
	{
		// Current patch Precommit PC (7.6.1, 7.7, …) on SB Prod Controller-4.
		ID: "precommit-pc-c4", Controller: "sbprod4", Parent: []string{"Nupipe", "Precommit_PC"},
		Label: "msp Precommit PC", ShortLabel: "Precommit", Lane: "Precommit",
		MasterName:   "",
		VersionRegex: regexp.MustCompile(`^msp-ganges-(\d+(?:\.\d+)*)-pc$`), JobPrefix: "msp-ganges-", JobSuffix: "-pc",
	},
	{
		// Current patch Local LCC (7.6.1, 7.7, …) on SB Prod Controller-4.
		// Master LCC stays on the sbprod (Controller-2) rule above.
		ID: "lcc-local-c4", Controller: "sbprod4", Parent: []string{"Nupipe", "LCC_NOS"},
		Label: "msp_master Local LCC", ShortLabel: "Local LCC", Lane: "LCC",
		MasterGroup: "msp-master", MasterName: "",
		VersionRegex: regexp.MustCompile(`^msp-ganges-(\d+(?:\.\d+)*)$`), JobPrefix: "msp-ganges-",
	},
	{
		// Postcommit / smoke. Master job is on SB Prod Controller-1.
		ID: "smoke", Controller: "sbprod1", Parent: []string{"Postcommit"},
		Label: "Smoke", ShortLabel: "Smoke", Lane: "Smoke",
		MasterGroup: "msp-master", MasterName: "master",
		VersionRegex: regexp.MustCompile(`^ganges-(\d+(?:\.\d+)*)-stable$`), JobPrefix: "ganges-", JobSuffix: "-stable",
	},
	{
		// Master LKG on SB Prod Controller-1 (Nupipe/LKG/master).
		ID: "lkg", Controller: "sbprod1", Parent: []string{"Nupipe", "LKG"},
		Label: "LKG", ShortLabel: "LKG", Lane: "LKG",
		MasterGroup: "lkg", MasterName: "master",
		VersionRegex: regexp.MustCompile(`^ganges-(\d+(?:\.\d+)*)-stable$`), JobPrefix: "ganges-", JobSuffix: "-stable",
	},
	{
		// Current LKG home (7.6.x, 7.7, …). Versioned jobs only — master LKG
		// is the lkg rule above (sbprod1). Listed after `lkg` so overlapping
		// versions prefer this controller.
		ID: "lkg-c1", Controller: "sbprod1", Parent: []string{"Nupipe", "LKG"},
		Label: "LKG", ShortLabel: "LKG", Lane: "LKG",
		MasterGroup: "lkg", MasterName: "",
		VersionRegex: regexp.MustCompile(`^ganges-(\d+(?:\.\d+)*)-stable$`), JobPrefix: "ganges-", JobSuffix: "-stable",
	},
}

// SlackConfig mirrors the Node SLACK object.
type SlackConfig struct {
	Enabled    bool // SLACK_ENABLED; false pauses all channel posts (tokens stay)
	Channel    string
	Mention    string
	WebhookURL string
	BotToken   string
	AppToken   string
	CooldownMs int64
}

// DigestTime is one { hour, minute, tz } send slot.
type DigestTime struct {
	Hour   int    `json:"hour"`
	Minute int    `json:"minute"`
	TZ     string `json:"tz"`
}

// MasterDigestConfig mirrors the Node MASTER_DIGEST object.
type MasterDigestConfig struct {
	Enabled       bool
	FailThreshold int
	Channel       string
	Times         []DigestTime
}

// SuccessDigestConfig is the optional green counterpart to the failure digest.
// Disabled unless SUCCESS_DIGEST_ENABLED=true.
type SuccessDigestConfig struct {
	Enabled   bool
	Threshold int
}

// Settings mirrors the Node SETTINGS object.
type Settings struct {
	Port               int
	Host               string
	PollInterval       time.Duration
	BuildsToTrack      int
	PatchFailThreshold int // PATCH_FAIL_THRESHOLD: patch/lane pipelines alert when >= N consecutive failures
	HTTPTimeout        time.Duration
	Concurrency        int
	DataDir            string
	DashboardURL       string
}

var (
	Slack         SlackConfig
	MasterDigest  MasterDigestConfig
	SuccessDigest SuccessDigestConfig
	Setting       Settings
)

func init() {
	Slack = SlackConfig{
		Enabled:    os.Getenv("SLACK_ENABLED") != "false",
		Channel:    env("SLACK_CHANNEL", "#test-msp"),
		Mention:    env("SLACK_MENTION", "@msp-help"),
		WebhookURL: os.Getenv("SLACK_WEBHOOK_URL"),
		BotToken:   firstNonEmpty(os.Getenv("SLACK_BOT_TOKEN"), os.Getenv("SLACK_ALERT_BOT_TOKEN")),
		AppToken:   os.Getenv("SLACK_APP_TOKEN"),
		CooldownMs: envInt64("SLACK_COOLDOWN_MS", 6*60*60*1000),
	}

	MasterDigest = MasterDigestConfig{
		Enabled:       os.Getenv("MASTER_DIGEST_ENABLED") != "false",
		FailThreshold: int(envInt64("MASTER_FAIL_THRESHOLD", 5)),
		Channel:       firstNonEmpty(os.Getenv("MASTER_DIGEST_CHANNEL"), os.Getenv("SLACK_CHANNEL"), "#test-msp"),
		Times:         parseDigestSchedule(),
	}

	SuccessDigest = SuccessDigestConfig{
		Enabled:   os.Getenv("SUCCESS_DIGEST_ENABLED") == "true",
		Threshold: int(envInt64("SUCCESS_THRESHOLD", 5)),
	}

	wd, _ := os.Getwd()
	Setting = Settings{
		Port:               int(envInt64("PORT", 4317)),
		Host:               env("HOST", "0.0.0.0"),
		PollInterval:       time.Duration(envInt64("POLL_INTERVAL_MS", 3*60*1000)) * time.Millisecond,
		BuildsToTrack:      10,
		PatchFailThreshold: int(envInt64("PATCH_FAIL_THRESHOLD", 3)),
		HTTPTimeout:        time.Duration(envInt64("HTTP_TIMEOUT_MS", 20000)) * time.Millisecond,
		Concurrency:        int(envInt64("FETCH_CONCURRENCY", 8)),
		DataDir:            env("DATA_DIR", wd+"/data"),
		DashboardURL:       os.Getenv("DASHBOARD_URL"),
	}
}

// parseDigestSchedule builds send slots from MASTER_DIGEST_TIMES × MASTER_DIGEST_TZ.
// TIMES is 24-hour HH:MM (comma-separated), e.g. "09:00" or "09:00,21:00".
// TZ is IST/PST aliases or IANA names, e.g. "IST,PST".
// Legacy "HH:MM Asia/Kolkata,HH:MM America/Los_Angeles" in TIMES is still accepted
// when MASTER_DIGEST_TZ is unset.
func parseDigestSchedule() []DigestTime {
	timesSpec := env("MASTER_DIGEST_TIMES", "09:00")
	if os.Getenv("MASTER_DIGEST_TZ") == "" && looksLegacyDigestTimes(timesSpec) {
		return parseLegacyDigestTimes(timesSpec)
	}
	tzs := parseTZList(env("MASTER_DIGEST_TZ", "IST,PST"))
	var out []DigestTime
	for _, hm := range strings.Split(timesSpec, ",") {
		h, m, ok := parseHHMM(strings.TrimSpace(hm))
		if !ok {
			continue
		}
		for _, tz := range tzs {
			out = append(out, DigestTime{Hour: h, Minute: m, TZ: tz})
		}
	}
	return out
}

func looksLegacyDigestTimes(spec string) bool {
	for _, part := range strings.Split(spec, ",") {
		if len(strings.Fields(strings.TrimSpace(part))) >= 2 {
			return true
		}
	}
	return false
}

func parseLegacyDigestTimes(spec string) []DigestTime {
	var out []DigestTime
	for _, part := range strings.Split(spec, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		fields := strings.Fields(part)
		hm := "09:00"
		tz := "UTC"
		if len(fields) > 0 {
			hm = fields[0]
		}
		if len(fields) > 1 {
			tz = resolveTZ(fields[1])
		}
		h, m, ok := parseHHMM(hm)
		if !ok {
			continue
		}
		out = append(out, DigestTime{Hour: h, Minute: m, TZ: tz})
	}
	return out
}

func parseHHMM(hm string) (hour, minute int, ok bool) {
	if hm == "" {
		return 0, 0, false
	}
	parts := strings.SplitN(hm, ":", 2)
	h, err := strconv.Atoi(parts[0])
	if err != nil || h < 0 || h > 23 {
		return 0, 0, false
	}
	m := 0
	if len(parts) > 1 {
		m, err = strconv.Atoi(parts[1])
		if err != nil || m < 0 || m > 59 {
			return 0, 0, false
		}
	}
	return h, m, true
}

func parseTZList(spec string) []string {
	var out []string
	for _, part := range strings.Split(spec, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		out = append(out, resolveTZ(part))
	}
	if len(out) == 0 {
		return []string{"Asia/Kolkata", "America/Los_Angeles"}
	}
	return out
}

func resolveTZ(name string) string {
	switch strings.ToUpper(strings.TrimSpace(name)) {
	case "IST":
		return "Asia/Kolkata"
	case "PST", "PT", "PDT":
		return "America/Los_Angeles"
	default:
		return name
	}
}

// DashboardURL returns the best-effort public URL for Slack links.
// Priority: DASHBOARD_URL env > bound host (if specific) > hostname > LAN IP > localhost.
func DashboardURL() string {
	if Setting.DashboardURL != "" {
		return strings.TrimRight(Setting.DashboardURL, "/")
	}
	var host string
	bound := Setting.Host
	if bound != "" && bound != "0.0.0.0" && bound != "::" {
		host = bound
	} else {
		h, _ := os.Hostname()
		host = h
		if host == "" {
			host = firstLanIPv4()
		}
		if host == "" {
			host = "localhost"
		}
		if !strings.Contains(host, ".") && host != "localhost" {
			if ip := firstLanIPv4(); ip != "" {
				host = ip
			}
		}
	}
	portPart := ":" + strconv.Itoa(Setting.Port)
	if Setting.Port == 80 {
		portPart = ""
	}
	return "http://" + host + portPart
}

func firstLanIPv4() string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return ""
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := iface.Addrs()
		for _, a := range addrs {
			var ip net.IP
			switch v := a.(type) {
			case *net.IPNet:
				ip = v.IP
			case *net.IPAddr:
				ip = v.IP
			}
			if ip == nil || ip.IsLoopback() {
				continue
			}
			if v4 := ip.To4(); v4 != nil {
				return v4.String()
			}
		}
	}
	return ""
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envInt64(key string, def int64) int64 {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			return n
		}
	}
	return def
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}
