// Package jenkins is a small read-only JSON client for the Jenkins API.
// Ported from server/jenkins.js. Per-host TLS policy: internal controllers use
// self-signed certs so we skip verification for those (config.Insecure).
package jenkins

import (
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"

	"github.com/nutanix/msp-pipeline-dashboard/internal/config"
)

// RawBuild is the subset of a Jenkins build we request.
type RawBuild struct {
	Number    int    `json:"number"`
	Result    string `json:"result"`
	Building  bool   `json:"building"`
	Timestamp int64  `json:"timestamp"`
	Duration  int64  `json:"duration"`
	URL       string `json:"url"`
}

// RawHealth mirrors healthReport entries.
type RawHealth struct {
	Score       int    `json:"score"`
	Description string `json:"description"`
}

// RawJob is a Jenkins job's summary + last-N builds.
type RawJob struct {
	Name         string      `json:"name"`
	Color        string      `json:"color"`
	URL          string      `json:"url"`
	Builds       []RawBuild  `json:"builds"`
	LastBuild    *RawBuild   `json:"lastBuild"`
	HealthReport []RawHealth `json:"healthReport"`
}

// RawFolderJob is one child job from a folder listing.
type RawFolderJob struct {
	Name  string `json:"name"`
	Color string `json:"color"`
	Class string `json:"_class"`
}

type folderResponse struct {
	Jobs []RawFolderJob `json:"jobs"`
}

// JobResult wraps a fetch outcome (ok=false means unreachable/error).
type JobResult struct {
	OK    bool
	Data  *RawJob
	Error string
}

// FolderResult wraps a folder-listing outcome.
type FolderResult struct {
	OK    bool
	Jobs  []RawFolderJob
	Error string
}

var (
	insecureClient *http.Client
	secureClient   *http.Client
)

func init() {
	insecureTransport := &http.Transport{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, // internal CA on corp controllers
		MaxIdleConns:    32,
	}
	insecureClient = &http.Client{Timeout: config.Setting.HTTPTimeout, Transport: insecureTransport}
	secureClient = &http.Client{Timeout: config.Setting.HTTPTimeout}
}

// clientFor returns the right HTTP client for a controller's TLS policy.
func clientFor(c config.Controller) *http.Client {
	if strings.HasPrefix(c.BaseURL, "https:") && c.Insecure {
		return insecureClient
	}
	return secureClient
}

// getJSON performs a JSON GET against a controller and decodes into out.
func getJSON(controllerID, urlPath string, out any) (bool, string) {
	c, ok := config.Controllers[controllerID]
	if !ok {
		return false, "unknown controller " + controllerID
	}
	full := c.BaseURL + urlPath
	req, err := http.NewRequest(http.MethodGet, full, nil)
	if err != nil {
		return false, err.Error()
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "msp-pipeline-dashboard/1.0")

	resp, err := clientFor(c).Do(req)
	if err != nil {
		return false, err.Error()
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return false, err.Error()
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return false, fmt.Sprintf("HTTP %d", resp.StatusCode)
	}
	if err := json.Unmarshal(body, out); err != nil {
		return false, "invalid json"
	}
	return true, ""
}

// jobAPIPath builds /job/<seg>/.../<apiSuffix> with URL-escaped segments.
func jobAPIPath(segments []string, apiSuffix string) string {
	var b strings.Builder
	for _, s := range segments {
		b.WriteString("/job/")
		b.WriteString(url.PathEscape(s))
	}
	b.WriteString("/")
	b.WriteString(apiSuffix)
	return b.String()
}

// JobWebURL is the human-facing Jenkins job URL.
func JobWebURL(controllerID string, segments []string) string {
	c := config.Controllers[controllerID]
	var b strings.Builder
	b.WriteString(c.BaseURL)
	for _, s := range segments {
		b.WriteString("/job/")
		b.WriteString(url.PathEscape(s))
	}
	b.WriteString("/")
	return b.String()
}

// ListFolderJobs lists child jobs (name+color) of a folder for discovery.
func ListFolderJobs(controllerID string, parent []string) FolderResult {
	var fr folderResponse
	ok, errStr := getJSON(controllerID, jobAPIPath(parent, "api/json?tree=jobs[name,color,_class]"), &fr)
	if !ok {
		return FolderResult{OK: false, Error: errStr}
	}
	return FolderResult{OK: true, Jobs: fr.Jobs}
}

// FetchJob fetches a job summary + last-N builds.
func FetchJob(controllerID string, segments []string, buildsToTrack int) JobResult {
	n := buildsToTrack
	if n <= 0 {
		n = config.Setting.BuildsToTrack
	}
	suffix := fmt.Sprintf(
		"api/json?tree=name,color,url,"+
			"builds[number,result,building,timestamp,duration,url]{0,%d},"+
			"lastBuild[number,result,building,timestamp],"+
			"healthReport[score,description]", n)
	var rj RawJob
	ok, errStr := getJSON(controllerID, jobAPIPath(segments, suffix), &rj)
	if !ok {
		return JobResult{OK: false, Error: errStr}
	}
	return JobResult{OK: true, Data: &rj}
}

// MapLimit runs worker over items with bounded concurrency, preserving order.
func MapLimit[T any, R any](items []T, limit int, worker func(T) R) []R {
	results := make([]R, len(items))
	if limit < 1 {
		limit = 1
	}
	sem := make(chan struct{}, limit)
	var wg sync.WaitGroup
	for i := range items {
		wg.Add(1)
		sem <- struct{}{}
		go func(idx int) {
			defer wg.Done()
			defer func() { <-sem }()
			results[idx] = worker(items[idx])
		}(i)
	}
	wg.Wait()
	return results
}
