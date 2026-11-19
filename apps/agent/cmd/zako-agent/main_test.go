package main

import (
	"context"
	"testing"
	"time"
)

type stubSampler struct {
	results []bool
	calls   int
}

func (s *stubSampler) SampleOnce(context.Context) bool {
	s.calls++
	idx := s.calls - 1
	if idx >= len(s.results) {
		return false
	}
	return s.results[idx]
}

func TestPrimeCollector(t *testing.T) {
	t.Run("stops on first healthy sample", func(t *testing.T) {
		sampler := &stubSampler{results: []bool{true, false}}
		primeCollector(context.Background(), sampler, 5, time.Millisecond)
		if sampler.calls != 1 {
			t.Errorf("calls = %d, want 1", sampler.calls)
		}
	})

	t.Run("retries until healthy", func(t *testing.T) {
		sampler := &stubSampler{results: []bool{false, false, true}}
		primeCollector(context.Background(), sampler, 5, time.Millisecond)
		if sampler.calls != 3 {
			t.Errorf("calls = %d, want 3", sampler.calls)
		}
	})

	t.Run("caps retries when xray remains unhealthy", func(t *testing.T) {
		sampler := &stubSampler{results: []bool{false, false, false}}
		primeCollector(context.Background(), sampler, 3, time.Millisecond)
		if sampler.calls != 3 {
			t.Errorf("calls = %d, want 3", sampler.calls)
		}
	})

	t.Run("stops waiting when context cancels", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		sampler := &stubSampler{results: []bool{false, true}}
		primeCollector(ctx, sampler, 5, time.Second)
		if sampler.calls != 0 {
			t.Errorf("calls = %d, want 0 when already canceled", sampler.calls)
		}
	})

	t.Run("stops retry sleep when context cancels", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		sampler := &stubSampler{results: []bool{false, true}}
		go func() {
			time.Sleep(10 * time.Millisecond)
			cancel()
		}()
		start := time.Now()
		primeCollector(ctx, sampler, 5, time.Second)
		if sampler.calls != 1 {
			t.Errorf("calls = %d, want 1", sampler.calls)
		}
		if elapsed := time.Since(start); elapsed > 500*time.Millisecond {
			t.Errorf("elapsed = %s, want fast cancellation", elapsed)
		}
	})
}
