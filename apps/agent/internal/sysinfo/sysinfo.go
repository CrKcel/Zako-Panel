// Package sysinfo reads the optional system metrics carried in AgentReport.sys.
//
// Linux reads /proc directly with no cgo. Other platforms, including the darwin
// hosts used for Go tests, return ErrUnsupported with zero stats so the agent can
// omit sys instead of reporting fabricated values.
package sysinfo

import (
	"errors"
	"fmt"
	"os"
	"runtime"
	"strconv"
	"strings"
)

const (
	procLoadAvg = "/proc/loadavg"
	procUptime  = "/proc/uptime"
	procMeminfo = "/proc/meminfo"
	procStat    = "/proc/stat"
)

// ErrUnsupported is returned when the host has no /proc interface.
var ErrUnsupported = errors.New("sysinfo: unsupported platform")

// Stats mirrors the AgentReport.sys object. CPU and Mem are ratios in [0, 1].
type Stats struct {
	CPU    float64
	Mem    float64
	Load   float64
	Uptime int64
}

// CPUTimes are the aggregate cpu counters from /proc/stat. Diffing two snapshots
// yields interval utilization, which avoids reporting a since-boot average after
// the process has been running for a while.
type CPUTimes struct {
	Busy  uint64
	Total uint64
}

// Ratio returns the busy share between earlier and t. An earlier zero value
// yields the since-boot ratio; a zero total delta yields zero.
func (t CPUTimes) Ratio(earlier CPUTimes) float64 {
	if t.Total < earlier.Total || t.Busy < earlier.Busy {
		return 0
	}
	total := t.Total - earlier.Total
	if total == 0 {
		return 0
	}
	busy := t.Busy - earlier.Busy
	if busy > total {
		busy = total
	}
	return float64(busy) / float64(total)
}

// Read returns one snapshot. CPU is the aggregate since-boot ratio; callers that
// need interval utilization should diff ReadCPUTimes snapshots.
func Read() (Stats, error) {
	if runtime.GOOS != "linux" {
		return Stats{}, ErrUnsupported
	}

	load, err := readLoad()
	if err != nil {
		return Stats{}, err
	}
	uptime, err := readUptime()
	if err != nil {
		return Stats{}, err
	}
	mem, err := readMem()
	if err != nil {
		return Stats{}, err
	}
	cpu, err := readCPUTimes()
	if err != nil {
		return Stats{}, err
	}

	return Stats{CPU: cpu.Ratio(CPUTimes{}), Mem: mem, Load: load, Uptime: uptime}, nil
}

// ReadCPUTimes returns aggregate busy and total jiffies from /proc/stat.
func ReadCPUTimes() (CPUTimes, error) {
	if runtime.GOOS != "linux" {
		return CPUTimes{}, ErrUnsupported
	}
	return readCPUTimes()
}

func readLoad() (float64, error) {
	line, err := firstLine(procLoadAvg)
	if err != nil {
		return 0, err
	}
	fields := strings.Fields(line)
	if len(fields) == 0 {
		return 0, fmt.Errorf("sysinfo: %s has no load value", procLoadAvg)
	}
	load, err := strconv.ParseFloat(fields[0], 64)
	if err != nil {
		return 0, fmt.Errorf("sysinfo: parse %s: %w", procLoadAvg, err)
	}
	return load, nil
}

func readUptime() (int64, error) {
	line, err := firstLine(procUptime)
	if err != nil {
		return 0, err
	}
	fields := strings.Fields(line)
	if len(fields) == 0 {
		return 0, fmt.Errorf("sysinfo: %s has no uptime value", procUptime)
	}
	seconds, err := strconv.ParseFloat(fields[0], 64)
	if err != nil {
		return 0, fmt.Errorf("sysinfo: parse %s: %w", procUptime, err)
	}
	return int64(seconds), nil
}

func readMem() (float64, error) {
	data, err := os.ReadFile(procMeminfo)
	if err != nil {
		return 0, fmt.Errorf("sysinfo: read %s: %w", procMeminfo, err)
	}

	var total, available int64 = -1, -1
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		value, err := strconv.ParseInt(fields[1], 10, 64)
		if err != nil {
			continue
		}
		switch fields[0] {
		case "MemTotal:":
			total = value
		case "MemAvailable:":
			available = value
		}
	}
	if total <= 0 {
		return 0, fmt.Errorf("sysinfo: %s has no MemTotal", procMeminfo)
	}
	if available < 0 {
		return 0, fmt.Errorf("sysinfo: %s has no MemAvailable", procMeminfo)
	}
	if available > total {
		available = total
	}
	return float64(total-available) / float64(total), nil
}

func readCPUTimes() (CPUTimes, error) {
	data, err := os.ReadFile(procStat)
	if err != nil {
		return CPUTimes{}, fmt.Errorf("sysinfo: read %s: %w", procStat, err)
	}

	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 || fields[0] != "cpu" {
			continue
		}
		// Fields 1..8 are user, nice, system, idle, iowait, irq, softirq and
		// steal. guest/guest_nice are already included in user/nice, so summing
		// them again would double count.
		if len(fields) < 9 {
			return CPUTimes{}, fmt.Errorf("sysinfo: %s aggregate line has %d fields", procStat, len(fields))
		}
		var total, idle uint64
		for index := 1; index <= 8; index++ {
			value, err := strconv.ParseUint(fields[index], 10, 64)
			if err != nil {
				return CPUTimes{}, fmt.Errorf("sysinfo: parse %s cpu field %d: %w", procStat, index, err)
			}
			total += value
			if index == 4 || index == 5 {
				idle += value
			}
		}
		if total < idle {
			return CPUTimes{}, fmt.Errorf("sysinfo: %s cpu idle exceeds total", procStat)
		}
		return CPUTimes{Busy: total - idle, Total: total}, nil
	}
	return CPUTimes{}, fmt.Errorf("sysinfo: %s has no aggregate cpu line", procStat)
}

func firstLine(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("sysinfo: read %s: %w", path, err)
	}
	line, _, _ := strings.Cut(string(data), "\n")
	return line, nil
}
