/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderUsage } from "./usage.ts";
import type { UsageProps } from "./usageTypes.ts";

const noop = vi.fn();

function createUsageProps(overrides: Partial<UsageProps> = {}): UsageProps {
  return {
    data: {
      loading: false,
      error: null,
      sessions: [],
      sessionsLimitReached: false,
      totals: null,
      aggregates: null,
      costDaily: [],
      cacheStatus: undefined,
      providerLedger: null,
      providerLedgerError: null,
    },
    filters: {
      startDate: "2026-05-14",
      endDate: "2026-05-14",
      scope: "family",
      selectedSessions: [],
      selectedDays: [],
      selectedHours: [],
      query: "",
      queryDraft: "",
      timeZone: "local",
    },
    display: {
      chartMode: "tokens",
      dailyChartMode: "total",
      sessionSort: "tokens",
      sessionSortDir: "desc",
      recentSessions: [],
      sessionsTab: "all",
      visibleColumns: [],
      contextExpanded: false,
      headerPinned: false,
    },
    detail: {
      timeSeriesMode: "cumulative",
      timeSeriesBreakdownMode: "total",
      timeSeries: null,
      timeSeriesLoading: false,
      timeSeriesCursorStart: null,
      timeSeriesCursorEnd: null,
      sessionLogs: null,
      sessionLogsLoading: false,
      sessionLogsExpanded: false,
      logFilters: {
        roles: [],
        tools: [],
        hasTools: false,
        query: "",
      },
    },
    callbacks: {
      filters: {
        onStartDateChange: noop,
        onEndDateChange: noop,
        onScopeChange: noop,
        onRefresh: noop,
        onTimeZoneChange: noop,
        onToggleHeaderPinned: noop,
        onSelectDay: noop,
        onSelectHour: noop,
        onClearDays: noop,
        onClearHours: noop,
        onClearSessions: noop,
        onClearFilters: noop,
        onQueryDraftChange: noop,
        onApplyQuery: noop,
        onClearQuery: noop,
      },
      display: {
        onChartModeChange: noop,
        onDailyChartModeChange: noop,
        onSessionSortChange: noop,
        onSessionSortDirChange: noop,
        onSessionsTabChange: noop,
        onToggleColumn: noop,
      },
      details: {
        onToggleContextExpanded: noop,
        onToggleSessionLogsExpanded: noop,
        onLogFilterRolesChange: noop,
        onLogFilterToolsChange: noop,
        onLogFilterHasToolsChange: noop,
        onLogFilterQueryChange: noop,
        onLogFilterClear: noop,
        onSelectSession: noop,
        onTimeSeriesModeChange: noop,
        onTimeSeriesBreakdownChange: noop,
        onTimeSeriesCursorRangeChange: noop,
      },
    },
    ...overrides,
  };
}

describe("renderUsage", () => {
  it("omits the duplicate inner page heading because the shell owns tab headings", () => {
    const container = document.createElement("div");

    render(renderUsage(createUsageProps()), container);

    expect(container.querySelector(".usage-page-header")).toBeNull();
    expect(container.querySelector(".usage-page-title")).toBeNull();
    expect(container.querySelector(".usage-header")).not.toBeNull();
  });

  it("shows immutable provider receipts without coercing a missing dimension to zero", () => {
    const container = document.createElement("div");
    const completeDimension = {
      total: 10,
      knownSubtotal: 10,
      knownReceipts: 1,
      receiptCount: 1,
      coverage: "complete" as const,
    };

    render(
      renderUsage(
        createUsageProps({
          data: {
            loading: false,
            error: null,
            sessions: [],
            sessionsLimitReached: false,
            totals: null,
            aggregates: null,
            costDaily: [],
            cacheStatus: undefined,
            providerLedgerError: null,
            providerLedger: {
              source: "immutable_provider_call_receipts",
              startAt: "2026-05-14T00:00:00.000Z",
              endAt: "2026-05-14T23:59:59.999Z",
              highWatermark: 20,
              receiptCount: 1,
              lastReceiptAt: "2026-05-14T01:00:00.000Z",
              statusCounts: { succeeded: 1, failed: 0, interrupted: 0, cancelled: 0 },
              actualModels: [{ provider: "google", model: "gemini-3.6-flash", callCount: 1 }],
              actualModelCoverage: "complete",
              usage: {
                inputTotal: completeDimension,
                inputNonCached: completeDimension,
                cacheRead: completeDimension,
                cacheWrite: {
                  total: null,
                  knownSubtotal: null,
                  knownReceipts: 0,
                  receiptCount: 1,
                  coverage: "unavailable",
                },
                outputCandidates: completeDimension,
                reasoningThinking: completeDimension,
                toolUsePrompt: completeDimension,
                providerReportedTotal: completeDimension,
              },
              receiptCoverage: { complete: 1, partial: 0, unavailable: 0 },
              usageCoverage: { complete: 0, partial: 1, unavailable: 0 },
              producerCoverage: "partial",
              producerCoverageDigests: [`sha256:${"a".repeat(64)}`],
              cost: {
                status: "unavailable",
                amountUsd: null,
                reason: "pricing_not_in_provider_receipt_ledger",
              },
            },
          },
        }),
      ),
      container,
    );

    const text = container.querySelector(".usage-provider-ledger")?.textContent ?? "";
    expect(text).toContain("google/gemini-3.6-flash");
    expect(text).toContain("Unavailable (0/1 receipts)");
    expect(text).toContain("Unavailable (no pricing evidence)");
    expect(text).not.toContain("Cache write0");
  });
});
