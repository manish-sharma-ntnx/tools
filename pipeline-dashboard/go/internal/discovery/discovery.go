// Package discovery auto-finds version-scoped pipelines by listing Jenkins
// folders and regexing the version out of child job names.
// Ported from server/discovery.js.
package discovery

import (
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/nutanix/msp-pipeline-dashboard/internal/config"
	"github.com/nutanix/msp-pipeline-dashboard/internal/jenkins"
)

// Meta describes one pipeline to fetch (produced by config + discovery).
type Meta struct {
	Key             string
	Controller      string
	Path            []string
	Lane            string
	RuleID          string
	MasterGroup     string
	Label           string
	Title           string
	Subtitle        string
	Version         string
	Category        string
	SynthesizedFrom string
}

// Result is the discovery output.
type Result struct {
	Masters      []Meta
	Versions     map[string][]Meta
	DiscoveredAt int64
	ErrorList    []DiscErr
}

// DiscErr is a per-rule folder-listing failure.
type DiscErr struct {
	Rule  string
	Error string
}

// CompareVersions compares two ganges version strings numerically, segment by
// segment. Returns <0 if a<b, 0 if equal, >0 if a>b.
func CompareVersions(a, b string) int {
	pa := splitNums(a)
	pb := splitNums(b)
	n := len(pa)
	if len(pb) > n {
		n = len(pb)
	}
	for i := 0; i < n; i++ {
		var x, y int
		if i < len(pa) {
			x = pa[i]
		}
		if i < len(pb) {
			y = pb[i]
		}
		if x != y {
			return x - y
		}
	}
	return 0
}

func splitNums(v string) []int {
	parts := strings.Split(v, ".")
	out := make([]int, len(parts))
	for i, p := range parts {
		out[i], _ = strconv.Atoi(p)
	}
	return out
}

// TrainOf groups a version into its major.minor train, e.g. 7.6.0.1 -> 7.6.
func TrainOf(version string) string {
	parts := strings.Split(version, ".")
	if len(parts) > 2 {
		parts = parts[:2]
	}
	return strings.Join(parts, ".")
}

// DiscoverPipelines lists every discovery rule's folder and builds the meta set.
func DiscoverPipelines() Result {
	masters := []Meta{}
	versions := map[string][]Meta{}
	errs := []DiscErr{}

	for _, rule := range config.DiscoveryRules {
		res := jenkins.ListFolderJobs(rule.Controller, rule.Parent)
		if !res.OK {
			errs = append(errs, DiscErr{Rule: rule.ID, Error: res.Error})
			continue
		}

		// Master job for this lane, when it has one.
		if rule.MasterName != "" {
			for _, j := range res.Jobs {
				if j.Name == rule.MasterName {
					mg := rule.MasterGroup
					if mg == "" {
						mg = "other"
					}
					masters = append(masters, Meta{
						Key:         rule.ID + ":master",
						Controller:  rule.Controller,
						Path:        append(append([]string{}, rule.Parent...), rule.MasterName),
						Lane:        rule.Lane,
						RuleID:      rule.ID,
						MasterGroup: mg,
						Label:       rule.Label,
						Title:       rule.ShortLabel + " master",
						Subtitle:    j.Name,
						Version:     "master",
					})
					break
				}
			}
		}

		// Version-scoped jobs. Later rules win on the same version+lane so
		// controller-1 LKG replaces harbinger-14 for overlapping trains.
		for _, j := range res.Jobs {
			m := rule.VersionRegex.FindStringSubmatch(j.Name)
			if m == nil || len(m) < 2 {
				continue
			}
			version := m[1]
			mg := rule.MasterGroup
			if mg == "" {
				mg = "other"
			}
			upsertVersionJob(versions, Meta{
				Key:         rule.ID + ":" + version,
				Controller:  rule.Controller,
				Path:        append(append([]string{}, rule.Parent...), j.Name),
				Lane:        rule.Lane,
				RuleID:      rule.ID,
				MasterGroup: mg,
				Label:       rule.Label,
				Title:       rule.ShortLabel + " " + version,
				Subtitle:    j.Name,
				Version:     version,
			})
		}
	}

	return Result{
		Masters:      masters,
		Versions:     versions,
		DiscoveredAt: time.Now().UnixMilli(),
		ErrorList:    errs,
	}
}

// upsertVersionJob records a version-scoped job. A later rule with the same
// version+lane replaces the earlier one (used when LKG moved controllers).
func upsertVersionJob(versions map[string][]Meta, meta Meta) {
	list := versions[meta.Version]
	for i, existing := range list {
		if existing.Lane == meta.Lane {
			list[i] = meta
			versions[meta.Version] = list
			return
		}
	}
	versions[meta.Version] = append(list, meta)
}

// SortedVersions returns version keys newest-first.
func SortedVersions(versions map[string][]Meta) []string {
	keys := make([]string, 0, len(versions))
	for k := range versions {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		return CompareVersions(keys[i], keys[j]) > 0
	})
	return keys
}
