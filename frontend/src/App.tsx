// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import React, { useState, useEffect } from 'react';
import AppLayout from '@cloudscape-design/components/app-layout';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Container from '@cloudscape-design/components/container';
import FormField from '@cloudscape-design/components/form-field';
import Select from '@cloudscape-design/components/select';
import Multiselect from '@cloudscape-design/components/multiselect';
import DatePicker from '@cloudscape-design/components/date-picker';
import TimeInput from '@cloudscape-design/components/time-input';
import Input from '@cloudscape-design/components/input';
import Button from '@cloudscape-design/components/button';
import Textarea from '@cloudscape-design/components/textarea';
import Alert from '@cloudscape-design/components/alert';
import Table from '@cloudscape-design/components/table';
import Box from '@cloudscape-design/components/box';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Badge from '@cloudscape-design/components/badge';
import Spinner from '@cloudscape-design/components/spinner';
import Pagination from '@cloudscape-design/components/pagination';
import Tabs from '@cloudscape-design/components/tabs';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import { config } from './config';
import { initDynamoClient, getRecentSessions, getContactRecord, getAgents, getContactsByDateRange } from './services/dynamoService';
import { CognitoAuth, getCurrentUser, signOut, getSession } from './auth/CognitoAuth';
import { CognitoUser } from 'amazon-cognito-identity-js';

const REGIONS = [
  { label: 'US East (N. Virginia)', value: 'us-east-1' },
  { label: 'US West (Oregon)', value: 'us-west-2' },
  { label: 'EU (Ireland)', value: 'eu-west-1' },
  { label: 'EU (Frankfurt)', value: 'eu-central-1' },
  { label: 'Asia Pacific (Singapore)', value: 'ap-southeast-1' },
  { label: 'Asia Pacific (Sydney)', value: 'ap-southeast-2' },
  { label: 'Asia Pacific (Tokyo)', value: 'ap-northeast-1' },
];

const TIMEZONES = [
  { label: `Browser (${Intl.DateTimeFormat().resolvedOptions().timeZone})`, value: Intl.DateTimeFormat().resolvedOptions().timeZone },
  { label: 'UTC (GMT)', value: 'UTC' },
  { label: 'US Eastern (ET)', value: 'America/New_York' },
  { label: 'US Central (CT)', value: 'America/Chicago' },
  { label: 'US Pacific (PT)', value: 'America/Los_Angeles' },
  { label: 'Australia/Sydney (AEST)', value: 'Australia/Sydney' },
  { label: 'Australia/Melbourne (AEST)', value: 'Australia/Melbourne' },
  { label: 'Europe/London (GMT/BST)', value: 'Europe/London' },
  { label: 'Europe/Frankfurt (CET)', value: 'Europe/Berlin' },
  { label: 'Asia/Singapore (SGT)', value: 'Asia/Singapore' },
  { label: 'Asia/Tokyo (JST)', value: 'Asia/Tokyo' },
  { label: 'Asia/Mumbai (IST)', value: 'Asia/Kolkata' },
];

function formatTimestamp(isoStr: string, tz: string): string {
  if (!isoStr) return '-';
  try {
    return new Date(isoStr).toLocaleString(undefined, { timeZone: tz });
  } catch {
    return new Date(isoStr).toLocaleString();
  }
}

function exportToCSV(filename: string, headers: string[], rows: string[][]) {
  const escapeCell = (val: string) => {
    if (val.includes(',') || val.includes('"') || val.includes('\n')) {
      return `"${val.replace(/"/g, '""')}"`;
    }
    return val;
  };
  const csvContent = [
    headers.map(escapeCell).join(','),
    ...rows.map(row => row.map(escapeCell).join(',')),
  ].join('\n');

  const blob = new Blob(['\ufeff' + csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authUser, setAuthUser] = useState<CognitoUser | null>(null);
  const [checkingAuth, setCheckingAuth] = useState(true);

  const [region, setRegion] = useState(config.region);
  const [logGroupName, setLogGroupName] = useState(config.logGroupName);
  const [sessionIds, setSessionIds] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingText, setLoadingText] = useState('Processing...');
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<any[]>([]);
  const [selectedSessions, setSelectedSessions] = useState<any[]>([]);
  const [contactRecords, setContactRecords] = useState<any[]>([]);
  const [showResults, setShowResults] = useState(false);
  const [agentFilter, setAgentFilter] = useState<string[]>([]);
  const [agents, setAgents] = useState<any[]>([]);
  const [datePreset, setDatePreset] = useState('today');
  const [customStartDate, setCustomStartDate] = useState('');
  const [customEndDate, setCustomEndDate] = useState('');
  const [customStartTime, setCustomStartTime] = useState('00:00');
  const [customEndTime, setCustomEndTime] = useState('23:59');
  const [timezone, setTimezone] = useState(() => {
    return localStorage.getItem('analyzer-timezone') || Intl.DateTimeFormat().resolvedOptions().timeZone;
  });
  const [currentPage, setCurrentPage] = useState(1);
  const [sortingColumn, setSortingColumn] = useState<any>({ sortingField: 'timestamp' });
  const [sortingDescending, setSortingDescending] = useState(true);
  const PAGE_SIZE = 20;

  useEffect(() => {
    const user = getCurrentUser();
    if (user) {
      user.getSession((err: any, session: any) => {
        if (!err && session && session.isValid()) {
          setIsAuthenticated(true);
          setAuthUser(user);
        }
        setCheckingAuth(false);
      });
    } else {
      setCheckingAuth(false);
    }
  }, []);

  useEffect(() => {
    if (isAuthenticated) {
      getSession().then(session => {
        initDynamoClient(session);
        // Auto-load agents after client init
        setTimeout(() => {
          getAgents().then(agentList => {
            setAgents(agentList.map((a: any) => ({ id: a.agentId, name: a.name })));
          }).catch(() => {});
        }, 500);
      }).catch(() => {
        initDynamoClient();
      });
    }
  }, [isAuthenticated]);

  const loadAgents = async () => {
    try {
      const agentList = await getAgents();
      setAgents(agentList.map((a: any) => ({ id: a.agentId, name: a.name })));
    } catch (e: any) {
      setError(`Failed to load agents: ${e.message}`);
    }
  };

  const getDateRange = () => {
    const now = new Date();
    let startDate: string;
    let endDate: string;

    // Use UTC dates since DynamoDB timestamps are stored in UTC
    const todayUTC = now.toISOString().slice(0, 10); // "2026-07-30"
    const yesterdayUTC = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const weekAgoUTC = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const tomorrowUTC = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    switch (datePreset) {
      case 'today':
        startDate = `${todayUTC}T00:00:00.000Z`;
        endDate = `${tomorrowUTC}T00:00:00.000Z`;
        break;
      case 'yesterday':
        startDate = `${yesterdayUTC}T00:00:00.000Z`;
        endDate = `${todayUTC}T00:00:00.000Z`;
        break;
      case '7days':
        startDate = `${weekAgoUTC}T00:00:00.000Z`;
        endDate = `${tomorrowUTC}T00:00:00.000Z`;
        break;
      case 'custom':
        const startDateNorm = customStartDate ? customStartDate.replace(/\//g, '-') : '';
        const endDateNorm = customEndDate ? customEndDate.replace(/\//g, '-') : '';
        startDate = startDateNorm ? `${startDateNorm}T${customStartTime}:00.000Z` : `${yesterdayUTC}T00:00:00.000Z`;
        endDate = endDateNorm ? `${endDateNorm}T${customEndTime}:59.999Z` : `${tomorrowUTC}T00:00:00.000Z`;
        break;
      default:
        startDate = `${todayUTC}T00:00:00.000Z`;
        endDate = `${tomorrowUTC}T00:00:00.000Z`;
    }
    return { startDate, endDate };
  };

  const fetchContacts = async () => {
    setLoading(true);
    setLoadingText('Fetching contacts...');
    setError(null);
    setCurrentPage(1);
    try {
      const dateRange = getDateRange();
      let contacts: any[] = [];
      if (agentFilter.length > 0) {
        // Fetch for each selected agent and merge
        for (const agent of agentFilter) {
          const agentContacts = await getContactsByDateRange(dateRange, agent, 100);
          contacts = contacts.concat(agentContacts);
        }
        // Deduplicate by contactId and sort by timestamp desc
        const seen = new Set<string>();
        contacts = contacts.filter((c: any) => {
          if (seen.has(c.contactId)) return false;
          seen.add(c.contactId);
          return true;
        }).sort((a: any, b: any) => (b.timestamp || '').localeCompare(a.timestamp || ''));
      } else {
        contacts = await getContactsByDateRange(dateRange, undefined, 100);
      }
      // Show any contact that produced at least one turn of metrics. Contacts with
      // turnCount 0 are correlation failures (no span data) and are not useful to show.
      // (Previously required >= 4 turns, which hid short calls such as single-turn
      // intent-classifier interactions.)
      setSessions(contacts.filter((s: any) => (s.turnCount || 0) >= 1).map((s: any) => ({
        sessionId: s.sessionId,
        contactId: s.contactId,
        timestamp: s.timestamp,
        agentName: s.agentName,
        assistantId: s.assistantId,
        turnCount: s.turnCount,
      })));
    } catch (e: any) {
      setError(`Error fetching sessions: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const analyzeSelected = async () => {
    if (selectedSessions.length === 0 && !sessionIds.trim()) {
      setError('Please select contacts or enter session IDs');
      return;
    }
    setLoading(true);
    setLoadingText('Loading session data...');
    setError(null);
    setShowResults(false);

    const ids = sessionIds.trim()
      ? sessionIds.split('\n').map((s: string) => s.trim()).filter(Boolean)
      : selectedSessions.map((s: any) => s.contactId || s.sessionId);

    try {
      const records: any[] = [];
      for (const id of ids.slice(0, 100)) {
        const record = await getContactRecord(id);
        if (record) {
          records.push(record);
        }
      }
      setContactRecords(records);
      setShowResults(records.length > 0);
    } catch (e: any) {
      setError(`Analysis failed: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  if (checkingAuth) {
    return (
      <Box textAlign="center" padding="xxxl">
        <Spinner size="large" />
      </Box>
    );
  }

  if (!isAuthenticated) {
    return (
      <CognitoAuth
        onAuthenticated={(user) => {
          setIsAuthenticated(true);
          setAuthUser(user);
        }}
      />
    );
  }

  return (
    <AppLayout
      content={
        <ContentLayout
          header={
            <Header
              variant="h1"
              description="Compare AI Agent latency, TTFT, STT/TTS overhead, token usage, and customer wait times across sessions"
              info={<Badge color="green">v3.0</Badge>}
              actions={
                <Button onClick={() => { signOut(); setIsAuthenticated(false); setAuthUser(null); }}>
                  Sign Out
                </Button>
              }
            >
              Amazon Connect AI Agent Performance Analyzer
            </Header>
          }
        >
          <SpaceBetween size="l">
            {/* Configuration */}
            <Container header={<Header variant="h2">Configuration</Header>}>
              <SpaceBetween size="m">
                <ColumnLayout columns={4}>
                  <FormField label="Date Range">
                    <Select
                      selectedOption={{ label: datePreset === 'today' ? 'Today' : datePreset === 'yesterday' ? 'Yesterday' : datePreset === '7days' ? 'Last 7 Days' : 'Custom', value: datePreset }}
                      onChange={({ detail }) => setDatePreset(detail.selectedOption.value!)}
                      options={[
                        { label: 'Today', value: 'today' },
                        { label: 'Yesterday', value: 'yesterday' },
                        { label: 'Last 7 Days', value: '7days' },
                        { label: 'Custom', value: 'custom' },
                      ]}
                    />
                  </FormField>
                  {datePreset === 'custom' && (
                    <FormField label="Start Date">
                      <SpaceBetween direction="horizontal" size="xs">
                        <DatePicker
                          value={customStartDate}
                          onChange={({ detail }) => setCustomStartDate(detail.value)}
                          placeholder="YYYY/MM/DD"
                        />
                        <TimeInput
                          value={customStartTime}
                          onChange={({ detail }) => setCustomStartTime(detail.value)}
                          format="hh:mm"
                          placeholder="00:00"
                        />
                      </SpaceBetween>
                    </FormField>
                  )}
                  {datePreset === 'custom' && (
                    <FormField label="End Date">
                      <SpaceBetween direction="horizontal" size="xs">
                        <DatePicker
                          value={customEndDate}
                          onChange={({ detail }) => setCustomEndDate(detail.value)}
                          placeholder="YYYY/MM/DD"
                        />
                        <TimeInput
                          value={customEndTime}
                          onChange={({ detail }) => setCustomEndTime(detail.value)}
                          format="hh:mm"
                          placeholder="23:59"
                        />
                      </SpaceBetween>
                    </FormField>
                  )}
                  <FormField label="AI Agent Filter">
                    <Multiselect
                      selectedOptions={agentFilter.map(a => ({ label: a, value: a }))}
                      onChange={({ detail }) => setAgentFilter(detail.selectedOptions.map((o: any) => o.value || ''))}
                      options={agents.map(a => ({ label: a.name, value: a.name }))}
                      placeholder="All Agents"
                      filteringType="auto"
                      tokenLimit={2}
                    />
                  </FormField>
                  <FormField label="Timezone">
                    <Select
                      selectedOption={TIMEZONES.find(t => t.value === timezone) || { label: timezone, value: timezone }}
                      onChange={({ detail }) => { setTimezone(detail.selectedOption.value!); localStorage.setItem('analyzer-timezone', detail.selectedOption.value!); }}
                      options={TIMEZONES}
                    />
                  </FormField>
                </ColumnLayout>
                <Button variant="primary" onClick={fetchContacts} loading={loading}>
                  Fetch Contacts
                </Button>
              </SpaceBetween>
            </Container>

            {/* Session Selector */}
            {sessions.length > 0 && (
              <Container header={<Header variant="h2" counter={`(${sessions.length})`} description="Select sessions to compare performance metrics side-by-side">Available Contacts</Header>}>
                <SpaceBetween size="m">
                  <Table
                    items={(() => {
                      const sorted = [...sessions].sort((a: any, b: any) => {
                        const field = sortingColumn?.sortingField || 'timestamp';
                        const aVal = a[field] || '';
                        const bVal = b[field] || '';
                        if (field === 'turnCount') return sortingDescending ? (bVal - aVal) : (aVal - bVal);
                        const cmp = String(aVal).localeCompare(String(bVal));
                        return sortingDescending ? -cmp : cmp;
                      });
                      return sorted.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
                    })()}
                    selectionType="multi"
                    selectedItems={selectedSessions}
                    onSelectionChange={({ detail }) => {
                      setSelectedSessions(detail.selectedItems);
                    }}
                    sortingColumn={sortingColumn}
                    sortingDescending={sortingDescending}
                    onSortingChange={({ detail }) => {
                      setSortingColumn(detail.sortingColumn);
                      setSortingDescending(detail.isDescending || false);
                      setCurrentPage(1);
                    }}
                    pagination={
                      <Pagination
                        currentPageIndex={currentPage}
                        pagesCount={Math.ceil(sessions.length / PAGE_SIZE)}
                        onChange={({ detail }) => setCurrentPage(detail.currentPageIndex)}
                      />
                    }
                    columnDefinitions={[
                      { id: 'timestamp', header: 'Date', cell: (item: any) => formatTimestamp(item.timestamp, timezone), sortingField: 'timestamp' },
                      { id: 'contactId', header: 'Contact ID', cell: (item: any) => item.contactId || '-', sortingField: 'contactId' },
                      { id: 'sessionId', header: 'Session ID', cell: (item: any) => <div style={{ whiteSpace: 'nowrap', overflowX: 'auto', maxWidth: 320 }}>{item.sessionId || '-'}</div>, sortingField: 'sessionId', width: 340 },
                      { id: 'agent', header: 'AI Agent', cell: (item: any) => item.agentName || '-', sortingField: 'agentName' },
                      { id: 'turns', header: 'Turns', cell: (item: any) => item.turnCount || '-', sortingField: 'turnCount' },
                    ]}
                    empty={<Box textAlign="center">No contacts found</Box>}
                    trackBy="contactId"
                  />
                  {/* Quick selection buttons */}
                  <SpaceBetween direction="horizontal" size="xs">
                    <Button variant="link" onClick={() => setSelectedSessions(sessions.slice(0, 10))}>
                      Select Recent 10
                    </Button>
                    <Button variant="link" onClick={() => setSelectedSessions(sessions.slice(0, 20))}>
                      Select Recent 20
                    </Button>
                    <Button variant="link" onClick={() => setSelectedSessions([...sessions])}>
                      Select All ({sessions.length})
                    </Button>
                    {selectedSessions.length > 0 && (
                      <Button variant="link" onClick={() => setSelectedSessions([])}>
                        Clear Selection
                      </Button>
                    )}
                  </SpaceBetween>
                  {selectedSessions.length > 10 && (
                    <Alert type="info">
                      {selectedSessions.length} sessions selected. Only the Aggregated Statistics tab will be shown (Session Comparison is limited to 10).
                    </Alert>
                  )}
                  <FormField label="Or enter Contact IDs manually (one per line)">
                    <Textarea
                      value={sessionIds}
                      onChange={({ detail }) => setSessionIds(detail.value)}
                      placeholder="e9c58b57-8aea-403f-a600-03a907eb2d20"
                      rows={2}
                    />
                  </FormField>
                  <Button
                    variant="primary"
                    onClick={analyzeSelected}
                    loading={loading}
                    disabled={selectedSessions.length === 0 && !sessionIds.trim()}
                  >
                    Check Performance ({selectedSessions.length > 0 ? `${selectedSessions.length} sessions` : 'selected'})
                  </Button>
                </SpaceBetween>
              </Container>
            )}

            {/* Manual Contact IDs - shown when no sessions loaded */}
            {sessions.length === 0 && (
              <Container header={<Header variant="h2">Enter Contact IDs</Header>}>
                <SpaceBetween size="m">
                  <FormField label="Contact IDs (one per line, max 10)">
                    <Textarea
                      value={sessionIds}
                      onChange={({ detail }) => setSessionIds(detail.value)}
                      placeholder="e9c58b57-8aea-403f-a600-03a907eb2d20"
                      rows={3}
                    />
                  </FormField>
                  <Button
                    variant="primary"
                    onClick={analyzeSelected}
                    loading={loading}
                    disabled={!sessionIds.trim()}
                  >
                    Check Performance
                  </Button>
                </SpaceBetween>
              </Container>
            )}

            {/* Loading */}
            {loading && (
              <Container>
                <Box textAlign="center" padding="l">
                  <Spinner size="large" />
                  <Box variant="p" margin={{ top: 's' }}>{loadingText}</Box>
                </Box>
              </Container>
            )}

            {/* Error */}
            {error && (
              <Alert type="error" dismissible onDismiss={() => setError(null)}>
                {error}
              </Alert>
            )}

            {/* Performance Comparison Table */}
            {showResults && contactRecords.length > 0 && (
              <SpaceBetween size="l">
                <Tabs
                  tabs={[
                    ...(contactRecords.length <= 10 ? [{
                      id: 'comparison',
                      label: 'Session Comparison',
                      content: (
                        <SpaceBetween size="l">
                          <PerformanceComparison records={contactRecords} timezone={timezone} />
                          <InteractionAnalysis records={contactRecords} />
                        </SpaceBetween>
                      ),
                    }] : []),
                    {
                      id: 'aggregated',
                      label: `Aggregated Statistics (${contactRecords.length})`,
                      content: <AggregatedStatistics records={contactRecords} allSessions={sessions} />,
                    },
                    {
                      id: 'documentation',
                      label: 'Documentation',
                      content: <DocumentationTab />,
                    },
                  ]}
                />
              </SpaceBetween>
            )}

            <Box textAlign="center" variant="small" color="text-status-info" padding={{ top: 'l' }}>
              Direct DynamoDB | Region: {region} | Timezone: {timezone}
            </Box>
          </SpaceBetween>
        </ContentLayout>
      }
      navigationHide
      toolsHide
    />
  );
}

/** Aggregated Statistics - percentile distribution across all sessions */
function AggregatedStatistics({ records, allSessions }: { records: any[]; allSessions: any[] }) {
  const [dataSource, setDataSource] = useState('selected');
  const [turnFilter, setTurnFilter] = useState('all');
  const [excludeAnomalies, setExcludeAnomalies] = useState(true);
  // Exclude runaway turns whose total duration exceeds a ceiling (ms). AI-based
  // testing can produce turns where the model hits its max output-token cap and
  // streams for 20s+, which are not representative of real classifier latency.
  // Tool-invocation turns legitimately take longer (they include tool execution),
  // so they get a separate, higher threshold. Both are configurable.
  const [excludeRunaway, setExcludeRunaway] = useState(true);
  const [runawayNoToolMs, setRunawayNoToolMs] = useState(10000);   // default 10s
  const [runawayWithToolMs, setRunawayWithToolMs] = useState(20000); // default 20s
  // Exclude disrupted turns whose STT/TTS is measured against an overlapping or
  // paused audio window (barge-in, pause, no Contact Lens match). These inflate
  // STT/TTS and Customer Wait and are not clean speech-processing measurements.
  // Same category set as the per-session detail view's outlier filter.
  const [excludeDisrupted, setExcludeDisrupted] = useState(true);
  const [modelFilter, setModelFilter] = useState<string[]>([]);
  const [agentFilterAgg, setAgentFilterAgg] = useState<string[]>([]);
  const [voiceEngineFilter, setVoiceEngineFilter] = useState<string[]>([]);
  const [allRecords, setAllRecords] = useState<any[]>([]);
  const [loadingAll, setLoadingAll] = useState(false);

  // Load all records when "All Fetched Sessions" is selected
  useEffect(() => {
    if (dataSource === 'all' && allSessions.length > 0 && allRecords.length === 0) {
      setLoadingAll(true);
      const loadAll = async () => {
        const loaded: any[] = [];
        for (const s of allSessions) {
          const contactId = s.contactId || s.sessionId;
          try {
            const record = await getContactRecord(contactId);
            if (record) loaded.push(record);
          } catch (e) { /* skip */ }
        }
        setAllRecords(loaded);
        setLoadingAll(false);
      };
      loadAll();
    }
  }, [dataSource, allSessions, allRecords.length]);

  // Source records based on selection
  let sourceRecords = dataSource === 'selected' ? records : (allRecords.length > 0 ? allRecords : records);

  // Apply agent filter
  if (agentFilterAgg.length > 0) {
    sourceRecords = sourceRecords.filter((r: any) => agentFilterAgg.includes(r.agentName));
  }

  // Apply model filter
  if (modelFilter.length > 0) {
    sourceRecords = sourceRecords.filter((r: any) => modelFilter.some(m => (r.aggregateMetrics?.primaryModel || '').includes(m)));
  }

  // Apply voice engine filter
  if (voiceEngineFilter.length > 0) {
    sourceRecords = sourceRecords.filter((r: any) => voiceEngineFilter.some(v => (r.voiceEngine || '').includes(v)));
  }

  // Extract unique agents, models, and voice engines for filter dropdowns
  const allSourceRecords = dataSource === 'selected' ? records : (allRecords.length > 0 ? allRecords : records);
  const uniqueAgents = Array.from(new Set(allSourceRecords.map((r: any) => r.agentName).filter(Boolean))) as string[];
  const uniqueModels = Array.from(new Set(allSourceRecords.map((r: any) => r.aggregateMetrics?.primaryModel).filter(Boolean))) as string[];
  const uniqueVoiceEngines = Array.from(new Set(allSourceRecords.map((r: any) => r.voiceEngine).filter(Boolean))) as string[];

  // Collect all turn-level data across sessions
  const allTurns = sourceRecords.flatMap((r: any) => r.turns || []);

  // Apply turn filter
  let filteredTurns = allTurns;
  if (turnFilter === 'no-tool') {
    filteredTurns = allTurns.filter((t: any) => !t.hasTool);
  } else if (turnFilter === 'with-tool') {
    filteredTurns = allTurns.filter((t: any) => t.hasTool);
  }

  // Exclude disrupted turns (barge-in, pause, no CL match). Their STT/TTS is measured
  // against an overlapping/paused audio window, so it inflates the speech-processing
  // and Customer Wait stats. Same categories as the per-session detail outlier filter.
  const DISRUPTED_CATEGORIES = ['no_cl_match', 'customer_barge_in', 'agent_barge_in', 'customer_pause'];
  const disruptedTurns = excludeDisrupted
    ? filteredTurns.filter((t: any) => DISRUPTED_CATEGORIES.includes(t.category))
    : [];
  if (excludeDisrupted) {
    filteredTurns = filteredTurns.filter((t: any) => !DISRUPTED_CATEGORIES.includes(t.category));
  }

  // Exclude runaway turns. Tool turns and non-tool turns use separate thresholds
  // because tool-invocation turns legitimately run longer (they include the tool
  // execution time). Keep the excluded turns so we can surface them to the user.
  const isRunaway = (t: any) => {
    const d = t.totalDurationMs || 0;
    const limit = t.hasTool ? runawayWithToolMs : runawayNoToolMs;
    return limit > 0 && d > limit;
  };
  const runawayTurns = excludeRunaway ? filteredTurns.filter(isRunaway) : [];
  if (excludeRunaway) {
    filteredTurns = filteredTurns.filter((t: any) => !isRunaway(t));
  }
  // Sessions that contained at least one runaway turn (for the summary banner).
  const runawaySessionIds = new Set(
    sourceRecords
      .filter((r: any) => (r.turns || []).some(isRunaway))
      .map((r: any) => r.contactId)
  );

  // Collect metric arrays
  // Speech Processing (STT + TTS): the non-LLM portion of the customer's silence
  // (speech recognition + routing + text-to-speech), reported as a single consistent
  // metric per turn. True per-component TTS is not measurable from the source data.
  const sttTtsValues = filteredTurns
    .filter((t: any) => t.speechProcessingMs != null)
    .map((t: any) => t.speechProcessingMs || 0)
    .filter((v: any) => v > 0);
  const orchValues = filteredTurns.map((t: any) => t.orchestrationMs).filter((v: any) => v > 0);
  const ttftValues = filteredTurns.map((t: any) => t.ttftMs).filter((v: any) => v > 0);
  const msgRemValues = filteredTurns.map((t: any) => t.msgRemMs).filter((v: any) => v != null && v > 0);
  const orchPlusTtft = filteredTurns.filter((t: any) => t.orchestrationMs > 0 && t.ttftMs > 0)
    .map((t: any) => t.orchestrationMs + t.ttftMs);
  // Customer Perceived Wait = Speech Processing (STT+TTS) + Orchestration + TTFT.
  // Msg Remainder (post-first-token generation) is excluded — it overlaps with the
  // streaming of early audio and is not part of the customer-perceived wait. Speech
  // Processing already folds that time in, so this reconciles to the real silence.
  const customerWait = filteredTurns
    .map((t: any) => (t.speechProcessingMs || 0) + (t.orchestrationMs || 0) + (t.ttftMs || 0))
    .filter((v: any) => v > 0);
  // Tool Execution: include every turn that actually invoked a tool, even when the
  // measured duration is 0ms. Some tools are instantaneous return-to-control calls
  // (0ms), while contact-flow or gateway MCP tools take real time. Counting the 0ms
  // ones lets us show "0ms" (tool ran, negligible time) instead of "-" (no tool).
  const toolValues = filteredTurns
    .filter((t: any) => t.hasTool)
    .map((t: any) => t.toolExecutionMs || 0);
  const inputTokens = filteredTurns.map((t: any) => t.inputTokens).filter((v: any) => v > 0);
  const outputTokens = filteredTurns.map((t: any) => t.outputTokens).filter((v: any) => v > 0);
  const totalTokensPerSession = sourceRecords.map((r: any) => {
    const turns = r.turns || [];
    return turns.reduce((sum: number, t: any) => sum + (t.inputTokens || 0) + (t.outputTokens || 0), 0);
  }).filter((v: number) => v > 0);

  // Optionally exclude anomalies (> 2.5x median). This only applies to the key
  // performance metrics (STT+TTS, Orchestration, TTFT, Customer Wait); other columns
  // (Msg Remainder, Tool Execution, tokens) are never outlier-filtered.
  const filterOutliers = (arr: number[]) => {
    if (!excludeAnomalies || arr.length < 3) return arr;
    const sorted = [...arr].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    return sorted.filter(v => v <= median * 2.5);
  };

  const computeStats = (values: number[], applyOutlierFilter = false) => {
    const sorted = (applyOutlierFilter ? filterOutliers([...values]) : [...values]).sort((a, b) => a - b);
    if (sorted.length === 0) return { min: '-', avg: '-', max: '-', p50: '-', p90: '-', p99: '-', count: 0, aboveP50: 0, aboveP90: 0 };
    const sum = sorted.reduce((a, b) => a + b, 0);
    const pct = (p: number) => sorted[Math.min(Math.floor(sorted.length * p / 100), sorted.length - 1)];
    const p50Val = pct(50);
    const p90Val = pct(90);
    return {
      min: Math.round(sorted[0]).toLocaleString(),
      avg: Math.round(sum / sorted.length).toLocaleString(),
      max: Math.round(sorted[sorted.length - 1]).toLocaleString(),
      p50: Math.round(p50Val).toLocaleString(),
      p90: Math.round(p90Val).toLocaleString(),
      p99: Math.round(pct(99)).toLocaleString(),
      count: sorted.length,
      aboveP50: sorted.filter(v => v > p50Val).length,
      aboveP90: sorted.filter(v => v > p90Val).length,
    };
  };

  // Outlier exclusion applies only to the key performance metrics.
  const sttTtsStats = computeStats(sttTtsValues, true);
  const orchStats = computeStats(orchValues, true);
  const ttftStats = computeStats(ttftValues, true);
  const cwStats = computeStats(customerWait, true);
  // Non-key metrics are never outlier-filtered.
  const msgRemStats = computeStats(msgRemValues);
  const orchTtftStats = computeStats(orchPlusTtft);
  const toolStats = computeStats(toolValues);
  const inputStats = computeStats(inputTokens);
  const outputStats = computeStats(outputTokens);
  const sessionTokenStats = computeStats(totalTokensPerSession);

  type StatRow = { metric: string; sttTts: string; orch: string; ttft: string; msgRem: string; customerWait: string; tool: string; inputTokens: string; outputTokens: string; totalTokens: string };

  const statRows: StatRow[] = [
    { metric: 'Avg', sttTts: sttTtsStats.avg, orch: orchStats.avg, ttft: ttftStats.avg, msgRem: msgRemStats.avg, customerWait: cwStats.avg, tool: toolStats.avg, inputTokens: inputStats.avg, outputTokens: outputStats.avg, totalTokens: sessionTokenStats.avg },
    { metric: 'Max', sttTts: sttTtsStats.max, orch: orchStats.max, ttft: ttftStats.max, msgRem: msgRemStats.max, customerWait: cwStats.max, tool: toolStats.max, inputTokens: inputStats.max, outputTokens: outputStats.max, totalTokens: sessionTokenStats.max },
    { metric: `P50 Median`, sttTts: sttTtsStats.p50, orch: orchStats.p50, ttft: ttftStats.p50, msgRem: msgRemStats.p50, customerWait: cwStats.p50, tool: toolStats.p50, inputTokens: inputStats.p50, outputTokens: outputStats.p50, totalTokens: sessionTokenStats.p50 },
    { metric: `P90 (${cwStats.aboveP50} above P50)`, sttTts: sttTtsStats.p90, orch: orchStats.p90, ttft: ttftStats.p90, msgRem: msgRemStats.p90, customerWait: cwStats.p90, tool: toolStats.p90, inputTokens: inputStats.p90, outputTokens: outputStats.p90, totalTokens: sessionTokenStats.p90 },
    { metric: `P99 (${cwStats.aboveP90} above P90)`, sttTts: sttTtsStats.p99, orch: orchStats.p99, ttft: ttftStats.p99, msgRem: msgRemStats.p99, customerWait: cwStats.p99, tool: toolStats.p99, inputTokens: inputStats.p99, outputTokens: outputStats.p99, totalTokens: sessionTokenStats.p99 },
  ];

  const exportAggregated = () => {
    const now = new Date().toLocaleString();
    const filterInfo = [
      ['Export Date', now],
      ['Data Source', dataSource === 'selected' ? `Selected Sessions (${records.length})` : `All Fetched Sessions (${allSessions.length})`],
      ['Sessions in Scope', String(sourceRecords.length)],
      ['Turn Filter', turnFilter === 'all' ? 'All Turns' : turnFilter === 'no-tool' ? 'Without Tool' : 'With Tool'],
      ['Exclude Anomalies', excludeAnomalies ? 'Yes (> 2.5x median; key metrics only: STT+TTS, Orchestration, TTFT, Customer Wait)' : 'No'],
      ['Exclude Runaway Turns', excludeRunaway ? `Yes (no-tool > ${runawayNoToolMs / 1000}s, tool > ${runawayWithToolMs / 1000}s) — ${runawayTurns.length} excluded` : 'No'],
      ['Exclude Disrupted Turns', excludeDisrupted ? `Yes (barge-in, pause, no CL match) — ${disruptedTurns.length} excluded` : 'No'],
      ['AI Agent Filter', agentFilterAgg.length > 0 ? agentFilterAgg.join('; ') : 'All Agents'],
      ['Model Filter', modelFilter.length > 0 ? modelFilter.join('; ') : 'All Models'],
      ['Voice/Engine Filter', voiceEngineFilter.length > 0 ? voiceEngineFilter.join('; ') : 'All Engines'],
      ['Total Turns', String(filteredTurns.length)],
      ['Turns with Speech Processing', String(sttTtsValues.length)],
      ['Turns with TTFT', String(ttftValues.length)],
      [''],
    ];
    const headers = ['Metric', 'Speech Processing', 'Orchestration', 'TTFT', 'Msg Remainder', 'Customer Wait', 'Tool Execution', 'Input Tokens', 'Output Tokens', 'Total Tokens/Session'];
    const csvRows = statRows.map(r => [r.metric, r.sttTts, r.orch, r.ttft, r.msgRem, r.customerWait, r.tool, r.inputTokens, r.outputTokens, r.totalTokens]);
    const allRows = [...filterInfo, headers, ...csvRows];
    exportToCSV('aggregated_statistics.csv', allRows[0], allRows.slice(1));
  };

  return (
    <Container header={
      <Header variant="h2" actions={<Button onClick={exportAggregated} iconName="download">Export CSV</Button>}>
        Aggregated Statistics ({sourceRecords.length} Sessions)
      </Header>
    }>
      <SpaceBetween size="m">
        <div style={{ fontSize: 13, color: '#6b7280' }}>
          Percentile distribution across all {sourceRecords.length} session{sourceRecords.length > 1 ? 's' : ''} in scope
          {' '}| {filteredTurns.length} total turns | {sttTtsValues.length} with Speech Processing | {customerWait.length} with Customer Wait | {ttftValues.length} with TTFT
          {loadingAll && ' (loading all sessions...)'}
        </div>
        <div style={{ fontSize: 12, color: '#9ca3af', fontStyle: 'italic' }}>
          Each column is an independent distribution over the turns where that component is present, so a
          single row (e.g. Avg or P90) is not one turn and its columns are not meant to sum. Customer Wait
          is computed per turn as Speech Processing (STT+TTS) + Orchestration + TTFT (Msg Remainder is
          excluded — it overlaps the streaming of early audio and is shown separately as LLM detail).
          This reconciles to the real customer-facing silence. Speech Processing (STT+TTS) is the non-LLM
          portion of that silence; true per-component TTS is not measurable from the source data, so STT
          and TTS are reported together.
        </div>

        {excludeDisrupted && disruptedTurns.length > 0 && (
          <Alert type="info" header={`Excluded ${disruptedTurns.length} disrupted turn${disruptedTurns.length > 1 ? 's' : ''} (barge-in, pause, no CL match)`}>
            These turns have overlapping or paused audio, so their Speech Processing (STT+TTS) is measured against a disrupted window and would inflate the speech-processing and Customer Wait stats. Uncheck "Exclude disrupted turns" to include them.
          </Alert>
        )}

        {excludeRunaway && runawayTurns.length > 0 && (
          <Alert type="info" header={`Excluded ${runawayTurns.length} runaway turn${runawayTurns.length > 1 ? 's' : ''} across ${runawaySessionIds.size} session${runawaySessionIds.size > 1 ? 's' : ''} (no-tool > ${runawayNoToolMs / 1000}s, tool > ${runawayWithToolMs / 1000}s)`}>
            These turns exceeded the latency ceiling for their type and are excluded from the stats above. They are commonly AI-test artifacts where the model hit its max output-token cap and streamed a long response.
            <Box variant="p" padding={{ top: 'xs' }}>
              {runawayTurns
                .slice()
                .sort((a: any, b: any) => (b.totalDurationMs || 0) - (a.totalDurationMs || 0))
                .slice(0, 10)
                .map((t: any, i: number) => (
                  <span key={i} style={{ display: 'inline-block', marginRight: 12, fontSize: 12 }}>
                    Turn {t.turnNumber ?? '?'} [{t.hasTool ? 'tool' : 'no-tool'}]: {(t.totalDurationMs || 0).toLocaleString()}ms
                    {t.outputTokens ? ` (${t.outputTokens} out-tok)` : ''}
                  </span>
                ))}
              {runawayTurns.length > 10 && <span style={{ fontSize: 12 }}>…and {runawayTurns.length - 10} more</span>}
            </Box>
          </Alert>
        )}

        {/* Filters row 1 */}
        <ColumnLayout columns={3}>
          <FormField label="Data Source">
            <Select
              selectedOption={{ label: dataSource === 'selected' ? `Selected Sessions (${records.length})` : `All Fetched Sessions (${allSessions.length})`, value: dataSource }}
              onChange={({ detail }) => setDataSource(detail.selectedOption.value!)}
              options={[
                { label: `Selected Sessions (${records.length})`, value: 'selected' },
                { label: `All Fetched Sessions (${allSessions.length})`, value: 'all' },
              ]}
            />
          </FormField>
          <FormField label="Turns">
            <Select
              selectedOption={{ label: turnFilter === 'all' ? 'All Turns' : turnFilter === 'no-tool' ? 'Without Tool' : 'With Tool', value: turnFilter }}
              onChange={({ detail }) => setTurnFilter(detail.selectedOption.value!)}
              options={[
                { label: 'All Turns', value: 'all' },
                { label: 'Without Tool', value: 'no-tool' },
                { label: 'With Tool', value: 'with-tool' },
              ]}
            />
          </FormField>
          <FormField label="Exclude Anomalies">
            <div style={{ paddingTop: 8 }}>
              <label style={{ cursor: 'pointer', fontSize: 14, display: 'block', marginBottom: 6 }}>
                <input
                  type="checkbox"
                  checked={excludeAnomalies}
                  onChange={(e) => setExcludeAnomalies(e.target.checked)}
                  style={{ marginRight: 6 }}
                />
                Exclude outliers (&gt; 2.5x median)
              </label>
              <div style={{ paddingLeft: 22, marginBottom: 6, fontSize: 12, color: excludeAnomalies ? '#6b7280' : '#9ca3af' }}>
                Applies only to key performance metrics: STT + TTS, Orchestration, TTFT, and Customer Wait.
              </div>
              <label style={{ cursor: 'pointer', fontSize: 14, display: 'block', marginBottom: 4 }}>
                <input
                  type="checkbox"
                  checked={excludeRunaway}
                  onChange={(e) => setExcludeRunaway(e.target.checked)}
                  style={{ marginRight: 6 }}
                />
                Exclude runaway turns
              </label>
              <div style={{ paddingLeft: 22, fontSize: 13, color: excludeRunaway ? '#374151' : '#9ca3af' }}>
                <div style={{ marginBottom: 3 }}>
                  No-tool turns &gt;{' '}
                  <select
                    value={runawayNoToolMs}
                    disabled={!excludeRunaway}
                    onChange={(e) => setRunawayNoToolMs(Number(e.target.value))}
                    style={{ fontSize: 13 }}
                  >
                    <option value={6000}>6s</option>
                    <option value={8000}>8s</option>
                    <option value={10000}>10s</option>
                    <option value={15000}>15s</option>
                  </select>
                </div>
                <div>
                  Tool turns &gt;{' '}
                  <select
                    value={runawayWithToolMs}
                    disabled={!excludeRunaway}
                    onChange={(e) => setRunawayWithToolMs(Number(e.target.value))}
                    style={{ fontSize: 13 }}
                  >
                    <option value={15000}>15s</option>
                    <option value={20000}>20s</option>
                    <option value={30000}>30s</option>
                    <option value={45000}>45s</option>
                  </select>
                </div>
              </div>
              <label style={{ cursor: 'pointer', fontSize: 14, display: 'block', marginTop: 6 }}>
                <input
                  type="checkbox"
                  checked={excludeDisrupted}
                  onChange={(e) => setExcludeDisrupted(e.target.checked)}
                  style={{ marginRight: 6 }}
                />
                Exclude disrupted turns (barge-in, pause, no CL match)
              </label>
            </div>
          </FormField>
        </ColumnLayout>

        {/* Filters row 2 */}
        <ColumnLayout columns={3}>
          <FormField label="AI Agent">
            <Multiselect
              selectedOptions={agentFilterAgg.map(a => ({ label: a, value: a }))}
              onChange={({ detail }) => setAgentFilterAgg(detail.selectedOptions.map((o: any) => o.value || ''))}
              options={uniqueAgents.map(a => ({ label: a, value: a }))}
              placeholder="All Agents"
              filteringType="auto"
              tokenLimit={1}
            />
          </FormField>
          <FormField label="Model">
            <Multiselect
              selectedOptions={modelFilter.map(m => ({ label: m.replace(/^(us\.|eu\.|ap\.)/, ''), value: m }))}
              onChange={({ detail }) => setModelFilter(detail.selectedOptions.map((o: any) => o.value || ''))}
              options={uniqueModels.map(m => ({ label: m.replace(/^(us\.|eu\.|ap\.)/, ''), value: m }))}
              placeholder="All Models"
              filteringType="auto"
              tokenLimit={1}
            />
          </FormField>
          <FormField label="Voice / Engine">
            <Multiselect
              selectedOptions={voiceEngineFilter.map(v => ({ label: v, value: v }))}
              onChange={({ detail }) => setVoiceEngineFilter(detail.selectedOptions.map((o: any) => o.value || ''))}
              options={uniqueVoiceEngines.map(v => ({ label: v, value: v }))}
              placeholder="All Engines"
              tokenLimit={1}
            />
          </FormField>
        </ColumnLayout>

        {/* Stats Table */}
        {loadingAll ? (
          <Box textAlign="center" padding="l"><Spinner /> Loading all session data...</Box>
        ) : (
          <Table
            items={statRows}
            stripedRows
            variant="embedded"
            columnDefinitions={[
              { id: 'metric', header: 'Metric', cell: (item) => <Box fontWeight="bold">{item.metric}</Box>, width: 100 },
              { id: 'sttTts', header: 'Speech Processing', cell: (item) => item.sttTts !== '-' ? `${item.sttTts}ms` : '-' },
              { id: 'orch', header: 'Orchestration', cell: (item) => item.orch !== '-' ? `${item.orch}ms` : '-' },
              { id: 'ttft', header: 'TTFT', cell: (item) => item.ttft !== '-' ? `${item.ttft}ms` : '-' },
              { id: 'msgRem', header: 'Msg Remainder', cell: (item) => item.msgRem !== '-' ? `${item.msgRem}ms` : '-' },
              { id: 'customerWait', header: 'Customer Wait', cell: (item) => item.customerWait !== '-' ? `${item.customerWait}ms` : '-' },
              { id: 'tool', header: 'Tool Execution', cell: (item) => item.tool !== '-' ? `${item.tool}ms` : '-' },
              { id: 'inputTokens', header: 'Input Tokens', cell: (item) => item.inputTokens },
              { id: 'outputTokens', header: 'Output Tokens', cell: (item) => item.outputTokens },
              { id: 'totalTokens', header: 'Total Tokens/Session', cell: (item) => item.totalTokens },
            ]}
          />
        )}
      </SpaceBetween>
    </Container>
  );
}

/** Performance Comparison component - shows sessions side by side */
function PerformanceComparison({ records, timezone }: { records: any[]; timezone: string }) {
  // Collapsed state per section. Sections start collapsed by default; the set holds
  // the section labels that are currently EXPANDED (empty = all collapsed).
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());
  const toggleSection = (label: string) => {
    setExpandedSections(prev => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label); else next.add(label);
      return next;
    });
  };

  const fmt = (val: any, suffix = 'ms') => {
    if (val === null || val === undefined || val === 0) return 'N/A';
    return typeof val === 'number' ? `${val.toLocaleString()}${suffix}` : String(val);
  };
  const fmtNum = (val: any) => {
    if (val === null || val === undefined || val === 0) return 'N/A';
    return typeof val === 'number' ? val.toLocaleString() : String(val);
  };
  // Tool time: show the value even when it is 0ms, as long as the session actually
  // used a tool. A 0ms tool is a real, instantaneous invocation (e.g. return-to-control),
  // which is distinct from a session that had no tool at all (shown as N/A).
  const fmtToolTime = (val: any, r: any) => {
    const usedTool = (r?.aggregateMetrics?.totalTools || 0) > 0;
    if (!usedTool) return 'N/A';
    if (val === null || val === undefined) return '0ms';
    return typeof val === 'number' ? `${val.toLocaleString()}ms` : String(val);
  };

  // Build comparison rows. Each data row is tagged with the section it belongs to
  // (parentSection) so sections can be collapsed/expanded. Rows before the first
  // section header (session identity) have no parentSection and are always shown.
  type MetricRow = { metric: string; section?: string; parentSection?: string; values: string[] };
  const rows: MetricRow[] = [];
  let currentSection: string | undefined = undefined;

  const addSection = (label: string) => {
    currentSection = label;
    rows.push({ metric: '', section: label, values: [] });
  };
  const addRow = (metric: string, getter: (r: any) => string) =>
    rows.push({ metric, parentSection: currentSection, values: records.map(getter) });

  // Session Info
  addRow('Date', r => r.timestamp ? formatTimestamp(r.timestamp, timezone) : '-');
  addRow('Contact ID', r => r.contactId || '-');
  addRow('Session ID', r => r.sessionId || '-');
  addRow('Agent Name', r => r.agentName || '-');
  addRow('Voice / Engine', r => r.voiceEngine || '-');
  addRow('Primary Model', r => {
    const model = r.aggregateMetrics?.primaryModel || '';
    return model.replace(/^(us\.|eu\.|ap\.)/, '');
  });

  // Turn counts
  addRow('Total Turns', r => fmtNum(r.aggregateMetrics?.totalTurns));
  addRow('  With Tool', r => fmtNum(r.aggregateMetrics?.turnsWithTool));
  addRow('  Without Tool', r => fmtNum(r.aggregateMetrics?.turnsWithoutTool));

  // Turn durations
  addRow('Avg Turn (No Tool)', r => fmt(r.aggregateMetrics?.avgTurnWithoutTool));
  addRow('Max Turn (No Tool)', r => fmt(r.aggregateMetrics?.maxTurnWithoutTool));
  addRow('Avg Turn (With Tool)', r => fmt(r.aggregateMetrics?.avgTurnWithTool));
  addRow('Max Turn (With Tool)', r => fmt(r.aggregateMetrics?.maxTurnWithTool));

  // Detailed Latency Breakdown
  addSection('Detailed Latency Breakdown');
  addRow('Avg Orchestration', r => fmt(r.aggregateMetrics?.avgOrch));
  addRow('Max Orchestration', r => fmt(r.aggregateMetrics?.maxOrch));
  addRow('Avg TTFT', r => fmt(r.aggregateMetrics?.avgTtft));
  addRow('Max TTFT', r => fmt(r.aggregateMetrics?.maxTtft));
  addRow('Avg Orch + TTFT', r => fmt(r.aggregateMetrics?.avgOrchPlusTtft));
  addRow('Max Orch + TTFT', r => fmt(r.aggregateMetrics?.maxOrchPlusTtft));

  // Without Tool Breakdown
  addSection('Without Tool Breakdown');
  addRow('Avg Orch (No Tool)', r => fmt(r.aggregateMetrics?.avgOrchWithoutTool));
  addRow('Avg TTFT (No Tool)', r => fmt(r.aggregateMetrics?.avgTtftWithoutTool));
  addRow('Avg Orch+TTFT (No Tool)', r => fmt(r.aggregateMetrics?.avgOrchPlusTtftWithoutTool));

  // With Tool Breakdown
  addSection('With Tool Breakdown');
  addRow('Avg Orch (With Tool)', r => fmt(r.aggregateMetrics?.avgOrchWithTool));
  addRow('Avg TTFT (With Tool)', r => fmt(r.aggregateMetrics?.avgTtftWithTool));
  addRow('Avg Orch+TTFT (With Tool)', r => fmt(r.aggregateMetrics?.avgOrchPlusTtftWithTool));

  // LLM & Tools
  addSection('LLM Inference & Tools');
  addRow('Avg LLM Inference', r => fmt(r.aggregateMetrics?.avgLlmInference));
  addRow('Max LLM Inference', r => fmt(r.aggregateMetrics?.maxLlmInference));
  addRow('Total Inferences', r => fmtNum(r.aggregateMetrics?.totalInferences));
  addRow('Avg Tool Time', r => fmtToolTime(r.aggregateMetrics?.avgToolTime, r));
  addRow('Max Tool Time', r => fmtToolTime(r.aggregateMetrics?.maxToolTime, r));
  addRow('Total Tools Used', r => fmtNum(r.aggregateMetrics?.totalTools));

  // Tokens
  addSection('Token Usage');
  addRow('Total Input Tokens', r => fmtNum(r.aggregateMetrics?.totalInputTokens));
  addRow('Total Output Tokens', r => fmtNum(r.aggregateMetrics?.totalOutputTokens));
  addRow('Total Tokens', r => {
    const inp = r.aggregateMetrics?.totalInputTokens || 0;
    const out = r.aggregateMetrics?.totalOutputTokens || 0;
    return (inp + out) > 0 ? (inp + out).toLocaleString() : 'N/A';
  });
  addRow('Avg Input Tokens/Turn', r => fmtNum(r.aggregateMetrics?.avgInputTokensPerTurn));
  addRow('Avg Output Tokens/Turn', r => fmtNum(r.aggregateMetrics?.avgOutputTokensPerTurn));

  // Cache
  addSection('Prompt Caching');
  addRow('Cache Read Turns', r => {
    const v = r.aggregateMetrics?.cacheReadTurns;
    return v && v > 0 ? `${v} / ${r.aggregateMetrics?.totalInferences || 0}` : 'None';
  });
  addRow('Cache Read Tokens', r => {
    const v = r.aggregateMetrics?.totalCacheReadTokens;
    return v && v > 0 ? v.toLocaleString() : '-';
  });
  addRow('Cache Write Turns', r => {
    const v = r.aggregateMetrics?.cacheWriteTurns;
    return v && v > 0 ? `${v} / ${r.aggregateMetrics?.totalInferences || 0}` : 'None';
  });
  addRow('Cache Write Tokens', r => {
    const v = r.aggregateMetrics?.totalCacheWriteTokens;
    return v && v > 0 ? v.toLocaleString() : '-';
  });

  // Speech Processing (STT + TTS) / Msg Remainder (Contact Lens). Speech Processing is
  // the single non-LLM portion of the customer silence; per-component TTS is not
  // measurable from the source data.
  addSection('Speech Processing / Msg Remainder (Contact Lens)');
  addRow('Avg Speech Processing', r => fmt(r.aggregateMetrics?.avgSpeechProcessing));
  addRow('Max Speech Processing', r => fmt(r.aggregateMetrics?.maxSpeechProcessing));
  addRow('Avg Msg Remainder', r => fmt(r.aggregateMetrics?.avgMsgRem));
  addRow('Max Msg Remainder', r => fmt(r.aggregateMetrics?.maxMsgRem));
  addRow('Avg Customer Wait', r => fmt(r.aggregateMetrics?.avgCustomerWait));
  addRow('Max Customer Wait', r => fmt(r.aggregateMetrics?.maxCustomerWait));

  // Only show data rows whose parent section is expanded. Section header rows are
  // always shown (they are the toggles); rows with no parentSection (session identity)
  // are always shown.
  const visibleRows = rows.filter(r =>
    r.section !== undefined ||
    r.parentSection === undefined ||
    expandedSections.has(r.parentSection)
  );

  // Build column definitions dynamically
  const columnDefs: any[] = [
    {
      id: 'metric',
      header: 'Metric',
      cell: (item: MetricRow) => item.section
        ? (
          <Box fontWeight="bold" color="text-status-info">
            <span
              onClick={() => toggleSection(item.section as string)}
              style={{ cursor: 'pointer', userSelect: 'none' }}
            >
              {expandedSections.has(item.section) ? '\u25be' : '\u25b8'} {item.section}
            </span>
          </Box>
        )
        : <Box fontWeight={item.metric.startsWith('  ') ? 'normal' : 'bold'}>{item.metric}</Box>,
      width: 260,
    },
    ...records.map((_, idx) => ({
      id: `session-${idx}`,
      header: `Session ${idx + 1}`,
      cell: (item: MetricRow) => item.section ? '' : (
        <div style={{ whiteSpace: 'nowrap', overflowX: 'auto', maxWidth: 360 }}>{item.values[idx] || '-'}</div>
      ),
    })),
  ];

  const exportComparison = () => {
    const headers = ['Metric', ...records.map((_, i) => `Session ${i + 1}`)];
    const csvRows = rows.filter(r => !r.section).map(r => [r.metric, ...r.values]);
    exportToCSV('session_comparison.csv', headers, csvRows);
  };

  const allSectionLabels = rows.filter(r => r.section).map(r => r.section as string);

  return (
    <Container header={
      <Header
        variant="h2"
        counter={`(${records.length} sessions)`}
        actions={
          <SpaceBetween direction="horizontal" size="xs">
            <Button onClick={() => setExpandedSections(new Set(allSectionLabels))}>Expand all</Button>
            <Button onClick={() => setExpandedSections(new Set())}>Collapse all</Button>
            <Button onClick={exportComparison} iconName="download">Export CSV</Button>
          </SpaceBetween>
        }
      >
        Performance Comparison
      </Header>
    }>
      <Table
        items={visibleRows}
        columnDefinitions={columnDefs}
        variant="embedded"
        stripedRows
        wrapLines
      />
    </Container>
  );
}

/** Interaction Analysis - turn-by-turn latency breakdown for each session */
function InteractionAnalysis({ records }: { records: any[] }) {
  return (
    <Container header={<Header variant="h2">Interaction Analysis</Header>}>
      <Tabs
        tabs={records.map((record, idx) => ({
          id: `session-${idx}`,
          label: `Session ${idx + 1}`,
          content: <SessionBreakdown record={record} />,
        }))}
      />
    </Container>
  );
}

function SessionBreakdown({ record }: { record: any }) {
  const turns = record.turns || [];
  const agg = record.aggregateMetrics || {};
  const transcript = record.contactLens?.transcript || [];

  // Get customer and agent segments for conversation display
  const customerSegs = transcript
    .filter((s: any) => s.participant === 'CUSTOMER')
    .sort((a: any, b: any) => a.beginOffsetMillis - b.beginOffsetMillis);
  const agentSegs = transcript
    .filter((s: any) => s.participant === 'AGENT' || s.participant === 'SYSTEM')
    .sort((a: any, b: any) => a.beginOffsetMillis - b.beginOffsetMillis);

  const noToolTurns = turns.filter((t: any) => !t.hasTool);
  const withToolTurns = turns.filter((t: any) => t.hasTool);

  return (
    <Tabs tabs={[
      {
        id: 'latency',
        label: 'Latency Breakdown',
        content: (
          <SessionLatencyContent turns={turns} agg={agg} customerSegs={customerSegs} agentSegs={agentSegs} noToolTurns={noToolTurns} withToolTurns={withToolTurns} />
        ),
      },
      {
        id: 'conversation',
        label: 'Conversation Flow',
        content: <ConversationFlow turns={turns} transcript={transcript} record={record} />,
      },
    ]} />
  );
}

/** Latency breakdown content (extracted from old SessionBreakdown) */
function SessionLatencyContent({ turns, agg, customerSegs, agentSegs, noToolTurns, withToolTurns }: any) {
  const [excludeOutliers, setExcludeOutliers] = useState(false);

  // Filter turns if excluding outliers (no CL match, barge-in, pauses > 5s)
  const displayTurns = excludeOutliers
    ? turns.filter((t: any) =>
        t.category !== 'no_cl_match' &&
        t.category !== 'customer_barge_in' &&
        t.category !== 'agent_barge_in' &&
        t.customerWaitMs != null &&
        t.customerWaitMs > 0 &&
        t.customerWaitMs < 5000
      )
    : turns;

  // LLM Response = Orchestration + TTFT: the time from the agent being invoked until
  // the first token is produced (orchestration overhead plus time-to-first-token).
  const llmResponseMs = (t: any) => (t.orchestrationMs || 0) + (t.ttftMs || 0);
  const llmStats = (rows: any[]) => {
    const vals = rows.map(llmResponseMs).filter((v: number) => v > 0);
    if (vals.length === 0) return { avg: null, min: null, max: null };
    return {
      avg: Math.round(vals.reduce((a, b) => a + b, 0) / vals.length),
      min: Math.min(...vals),
      max: Math.max(...vals),
    };
  };
  const noToolLlm = llmStats(noToolTurns);
  const withToolLlm = llmStats(withToolTurns);

  // STT + TTS combined for display: sum per turn, counting a turn if either side
  // is present. Keeps a single clean number instead of two possibly-"N/A" values.
  const sttTtsCombined = (() => {
    const vals = turns
      .filter((t: any) => t.speechProcessingMs != null)
      .map((t: any) => t.speechProcessingMs || 0)
      .filter((v: number) => v > 0);
    if (vals.length === 0) return { avg: null, min: null, max: null, count: 0 };
    return {
      avg: Math.round(vals.reduce((a: number, b: number) => a + b, 0) / vals.length),
      min: Math.min(...vals),
      max: Math.max(...vals),
      count: vals.length,
    };
  })();

  return (
    <SpaceBetween size="l">
      {/* Outlier toggle */}
      <div style={{ paddingBottom: 4 }}>
        <label style={{ cursor: 'pointer', fontSize: 13 }}>
          <input
            type="checkbox"
            checked={excludeOutliers}
            onChange={(e) => setExcludeOutliers(e.target.checked)}
            style={{ marginRight: 6 }}
          />
          Exclude outlier turns (no CL match, barge-in, pauses &gt; 5s)
        </label>
        {excludeOutliers && <span style={{ marginLeft: 12, fontSize: 12, color: '#6b7280' }}>Showing {displayTurns.length} of {turns.length} turns</span>}
      </div>
      {/* Summary cards — LLM Response (no tool / with tool) and STT+TTS on one line,
          each showing AVG / FASTEST / SLOWEST. */}
      <ColumnLayout columns={3}>
        <StatCard
          title={`LLM Response — Orch + TTFT (No Tool) (${noToolTurns.length} turns)`}
          bg="#f0fdf4" border="#bbf7d0" titleColor="#166534"
          avg={noToolLlm.avg} min={noToolLlm.min} max={noToolLlm.max}
        />
        <StatCard
          title={`LLM Response — Orch + TTFT (With Tool) (${withToolTurns.length} turns)`}
          bg="#fffbeb" border="#fde68a" titleColor="#92400e"
          avg={withToolLlm.avg} min={withToolLlm.min} max={withToolLlm.max}
        />
        <StatCard
          title={`Speech Processing (${sttTtsCombined.count} turns)`}
          bg="#eff6ff" border="#bfdbfe" titleColor="#1d4ed8"
          avg={sttTtsCombined.avg} min={sttTtsCombined.min} max={sttTtsCombined.max}
        />
      </ColumnLayout>

      {/* Turn-by-turn breakdown */}
      {displayTurns.map((turn: any, idx: number) => {
        // Customer Perceived Wait = Speech Processing (STT+TTS) + Orch + TTFT
        // (Msg Remainder excluded; it overlaps early-audio streaming).
        const waitOf = (t: any) => (t.speechProcessingMs || 0) + (t.orchestrationMs || 0) + (t.ttftMs || 0);
        // Compute session averages for anomaly detection
        const avgTtft = displayTurns.filter((t: any) => t.ttftMs > 0).length > 0
          ? Math.round(displayTurns.filter((t: any) => t.ttftMs > 0).reduce((s: number, t: any) => s + t.ttftMs, 0) / displayTurns.filter((t: any) => t.ttftMs > 0).length)
          : 0;
        const waitTurns = displayTurns.filter((t: any) => waitOf(t) > 0);
        const avgWait = waitTurns.length > 0
          ? Math.round(waitTurns.reduce((s: number, t: any) => s + waitOf(t), 0) / waitTurns.length)
          : 0;

        const turnIdx = turn.turnNumber - 1;

        return (
          <TurnCard
            key={idx}
            turn={turn}
            index={turnIdx}
            customerSeg={customerSegs[turnIdx]}
            agentSeg={agentSegs.find((a: any) => customerSegs[turnIdx] && a.beginOffsetMillis > customerSegs[turnIdx]?.endOffsetMillis)}
            maxDuration={Math.max(...displayTurns.map((t: any) => waitOf(t) || t.totalDurationMs || 1))}
            sessionAvgTtft={avgTtft}
            sessionAvgWait={avgWait}
          />
        );
      })}
    </SpaceBetween>
  );
}

/** Conversation Flow - consolidated timeline view with all metrics per turn */
function ConversationFlow({ turns, transcript, record }: { turns: any[]; transcript: any[]; record: any }) {
  const customerSegs = transcript
    .filter((s: any) => s.participant === 'CUSTOMER')
    .sort((a: any, b: any) => a.beginOffsetMillis - b.beginOffsetMillis);
  const agentSegs = transcript
    .filter((s: any) => s.participant === 'AGENT' || s.participant === 'SYSTEM')
    .sort((a: any, b: any) => a.beginOffsetMillis - b.beginOffsetMillis);

  const categoryColors: Record<string, string> = {
    normal: '#e5e7eb',
    customer_barge_in: '#fecaca',
    agent_barge_in: '#fde68a',
    customer_pause: '#bbf7d0',
    tool_invocation: '#dbeafe',
    no_cl_match: '#f3f4f6',
  };
  const categoryLabels: Record<string, string> = {
    normal: '',
    customer_barge_in: 'Customer Barge-in',
    agent_barge_in: 'Agent Barge-in',
    customer_pause: 'Customer Pause',
    tool_invocation: 'Tool',
    no_cl_match: 'No CL Data',
  };

  return (
    <SpaceBetween size="s">
      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>
        Consolidated Contact Lens + ListSpans timeline ({turns.filter((t: any) => t.category !== 'no_cl_match').length} turns with transcript, {turns.length - turns.filter((t: any) => t.category !== 'no_cl_match').length} excluded without CL data)
      </div>
      {turns.filter((t: any) => t.category !== 'no_cl_match').map((turn: any, idx: number) => {
        const turnIdx = turn.turnNumber - 1;
        const custSeg = customerSegs[turnIdx];
        const agentSeg = agentSegs.find((a: any) => custSeg && a.beginOffsetMillis > custSeg?.endOffsetMillis);
        const category = turn.category || 'normal';
        const flags = turn.flags || [];
        const piiMismatch = turn.piiMismatch;

        return (
          <div key={idx} style={{ border: '1px solid #e5e7eb', borderLeft: `4px solid ${categoryColors[category] || '#e5e7eb'}`, borderRadius: 6, padding: '12px 16px', background: '#fff' }}>
            {/* Turn header row */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 700, fontSize: 14 }}>Turn {turn.turnNumber}</span>
                {categoryLabels[category] && (
                  <span style={{ background: categoryColors[category], padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 600 }}>
                    {categoryLabels[category]}
                  </span>
                )}
                {turn.hasTool && (
                  <span style={{ background: '#dbeafe', color: '#1e40af', padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 600 }}>
                    {turn.toolNames?.length > 0 ? turn.toolNames.join(', ') : 'Tool'}
                  </span>
                )}
                {piiMismatch && (
                  <span style={{ background: '#fef2f2', color: '#991b1b', padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 600 }}>
                    PII Mismatch: {piiMismatch.type}
                  </span>
                )}
                {flags.length > 0 && !categoryLabels[category] && (
                  <span style={{ fontSize: 10, color: '#6b7280' }}>{flags.join(' | ')}</span>
                )}
              </div>
              {turn.customerWaitMs > 0 && (
                <span style={{ fontSize: 11, color: '#374151', fontWeight: 600 }}>
                  Wait: {turn.customerWaitMs.toLocaleString()}ms
                </span>
              )}
            </div>

            {/* Conversation content */}
            <div style={{ display: 'flex', gap: 16, marginBottom: 8 }}>
              {/* Customer side */}
              <div style={{ flex: 1 }}>
                {custSeg && custSeg.content && (
                  <div style={{ background: '#f3f4f6', borderRadius: 8, padding: '8px 12px', fontSize: 13 }}>
                    <span style={{ color: '#6b7280', fontSize: 11 }}>Customer:</span>
                    <div style={{ marginTop: 2 }}>"{custSeg.content}"</div>
                    <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 4 }}>
                      {custSeg.endOffsetMillis - custSeg.beginOffsetMillis}ms
                    </div>
                  </div>
                )}
              </div>
              {/* Agent side */}
              <div style={{ flex: 1 }}>
                {agentSeg && agentSeg.content && (
                  <div style={{ background: '#eff6ff', borderRadius: 8, padding: '8px 12px', fontSize: 13 }}>
                    <span style={{ color: '#6b7280', fontSize: 11 }}>Agent:</span>
                    <div style={{ marginTop: 2 }}>"{agentSeg.content}"</div>
                    <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 4 }}>
                      {agentSeg.endOffsetMillis - agentSeg.beginOffsetMillis}ms
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Metrics row */}
            <div style={{ display: 'flex', gap: 16, fontSize: 11, color: '#374151', flexWrap: 'wrap' }}>
              {turn.speechProcessingMs != null && <span style={{ color: '#166534' }}>Speech Processing: {turn.speechProcessingMs}ms</span>}
              <span style={{ color: '#7c3aed' }}>Orch: {turn.orchestrationMs}ms</span>
              {turn.ttftMs > 0 && <span style={{ color: '#2563eb' }}>TTFT: {turn.ttftMs}ms</span>}
              {turn.msgRemMs != null && <span style={{ color: '#a21caf' }}>Msg Rem: {turn.msgRemMs}ms</span>}
              {turn.inferenceDurationMs > 0 && <span style={{ color: '#dc2626' }}>LLM Inf: {turn.inferenceDurationMs}ms</span>}
              {turn.hasTool && <span style={{ color: '#f97316' }}>Tool: {turn.toolExecutionMs || 0}ms</span>}
              <span style={{ color: '#6b7280' }}>Tokens: {turn.inputTokens || 0} in / {turn.outputTokens || 0} out</span>
              {turn.cacheReadTokens > 0 && <span style={{ color: '#059669' }}>Cache Read: {turn.cacheReadTokens}</span>}
            </div>

            {/* PII mismatch detail */}
            {piiMismatch && (
              <div style={{ marginTop: 6, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 4, padding: '6px 10px', fontSize: 11 }}>
                <strong>PII Mismatch ({piiMismatch.type}):</strong> Customer said "{piiMismatch.customer}" but agent echoed "{piiMismatch.agent}"
              </div>
            )}
          </div>
        );
      })}
    </SpaceBetween>
  );
}

function TurnCard({ turn, index, customerSeg, agentSeg, maxDuration, sessionAvgTtft, sessionAvgWait }: {
  turn: any; index: number; customerSeg: any; agentSeg: any; maxDuration: number;
  sessionAvgTtft: number; sessionAvgWait: number;
}) {
  // Speech Processing (STT + TTS) — the non-LLM portion of the customer silence,
  // reported as a single consistent metric. Per-component STT/TTS is not measurable.
  const speechProc = turn.speechProcessingMs || 0;
  const orch = turn.orchestrationMs || 0;
  const ttft = turn.ttftMs || 0;
  const msgRem = turn.msgRemMs || 0;
  // Customer Perceived Wait = Speech Processing (STT+TTS) + Orch + TTFT. Msg Remainder
  // is excluded (it overlaps the streaming of early audio, not the perceived wait).
  const customerWait = speechProc + orch + ttft;
  const remainder = turn.inferenceDurationMs ? Math.max(0, turn.inferenceDurationMs - ttft) : 0;
  const totalDur = turn.totalDurationMs || 0;
  const toolMs = turn.toolExecutionMs || 0;

  // Scale factor for bars: fixed 10-second (10000ms) baseline = 100% width
  // Each turn's bars are relative to a 10s scale so 1s = 10% of the bar
  const SCALE_BASE_MS = 10000;
  const scale = 100 / SCALE_BASE_MS;

  // Customer wait badge color
  const waitColor = customerWait > 5000 ? '#dc2626' : customerWait > 3000 ? '#f59e0b' : '#16a34a';

  // Anomaly detection
  const anomalies: string[] = [];
  const speechMissing = turn.speechProcessingMs === null || turn.speechProcessingMs === undefined;

  if (speechMissing && customerWait > 0) {
    anomalies.push('Speech Proc undecomposed (barge-in / distant pairing)');
  }
  if (ttft > 0 && sessionAvgTtft > 0 && ttft > sessionAvgTtft * 2) {
    anomalies.push(`TTFT ${ttft}ms (avg ${sessionAvgTtft}ms)`);
  }
  if (speechProc > 8000) {
    anomalies.push(`Speech Proc ${speechProc}ms (high)`);
  }
  if (customerWait > 0 && sessionAvgWait > 0 && customerWait > sessionAvgWait * 2.5) {
    anomalies.push(`Wait ${customerWait}ms (avg ${sessionAvgWait}ms)`);
  }
  // Category-based flags from Lambda processing
  if (turn.category === 'no_cl_match') {
    anomalies.push('No CL match');
  }
  if (turn.category === 'customer_barge_in') {
    anomalies.push('Customer Barge-in');
  }
  if (turn.category === 'agent_barge_in') {
    anomalies.push('Agent Barge-in');
  }
  if (turn.category === 'customer_pause') {
    anomalies.push('Customer Pause');
  }
  if (turn.piiMismatch) {
    anomalies.push(`PII Mismatch (${turn.piiMismatch.type})`);
  }

  // Conversation snippets
  const custText = customerSeg?.content ? `"${customerSeg.content.substring(0, 50)}${customerSeg.content.length > 50 ? '...' : ''}"` : '';
  const agentText = agentSeg?.content ? `"${agentSeg.content.substring(0, 50)}${agentSeg.content.length > 50 ? '...' : ''}"` : '';

  return (
    <div className="turn-card" style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: 16, background: '#fff' }}>
      {/* Turn header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8, flexWrap: 'wrap', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 700, fontSize: 16 }}>Turn {index + 1}</span>
          {/* Tool badges */}
          {turn.hasTool && (
            <span style={{ background: '#fef3c7', color: '#92400e', padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600 }}>
              {turn.toolNames && turn.toolNames.length > 0
                ? (() => {
                    const tools = turn.toolNames.map((t: any) => typeof t === 'string' ? t : t.name || 'Tool');
                    const toolType = turn.toolNames[0]?.type || 'third-party';
                    const typeLabel = toolType === 'first-party' ? '1P' : '3P';
                    return `[${typeLabel}] ${tools.join(', ')} (${toolMs}ms)`;
                  })()
                : `Tool ${toolMs}ms`}
            </span>
          )}
          {/* Anomaly badges */}
          {anomalies.length > 0 && (
            <span style={{ background: '#fef2f2', color: '#991b1b', padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 600 }}>
              {anomalies.join(' | ')}
            </span>
          )}
          {/* Conversation snippets */}
          {custText && <span style={{ fontSize: 11, color: '#6b7280' }}>{custText}</span>}
          {agentText && <span style={{ fontSize: 11, color: '#6b7280' }}>&rarr; {agentText}</span>}
        </div>
        {customerWait > 0 && (
          <span style={{ background: waitColor, color: '#fff', padding: '4px 12px', borderRadius: 16, fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>
            Customer Perceived Wait: {customerWait.toLocaleString()}ms
          </span>
        )}
      </div>

      {/* Speech Processing + Wait summary line */}
      {(speechProc > 0 || customerWait > 0) && (
        <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 6 }}>
          {speechProc > 0 && <span style={{ color: '#166534', marginRight: 12 }}>Speech Processing: {speechProc}ms</span>}
          {customerWait > 0 && <span>Wait: {customerWait}ms (Speech Processing {speechProc}ms + Orch {orch}ms + TTFT {ttft}ms)</span>}
        </div>
      )}

      {/* End-to-End Breakdown */}
      <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 8 }}>End-to-End Breakdown</div>

      {/* Bar: Customer Utterance (gray) - total duration of customer speaking */}
      {customerSeg && (
        <BarRow
          label="Customer Utterance"
          icon="pencil"
          segments={[{ width: Math.min(100, (customerSeg.endOffsetMillis - customerSeg.beginOffsetMillis) * scale), color: '#6b7280', label: `${customerSeg.endOffsetMillis - customerSeg.beginOffsetMillis}ms` }]}
          duration={customerSeg.endOffsetMillis - customerSeg.beginOffsetMillis}
        />
      )}

      {/* Bar: Speech Processing (STT + TTS) - the non-LLM portion of the customer's
          silence (speech recognition + routing + text-to-speech), shown as a single
          consistent bar. True per-component STT/TTS is not measurable from the data. */}
      {speechProc > 0 && (
        <BarRow
          label="Speech Processing"
          icon="mic"
          segments={[{ width: Math.max(3, speechProc * scale), color: '#16a34a', label: `${speechProc}ms` }]}
          duration={speechProc}
        />
      )}

      {/* Bar: LLM Processing (orchestration + TTFT + msg remainder) */}
      <BarRow
        label="LLM Processing"
        icon="brain"
        segments={[
          { width: Math.max(3, orch * scale), color: '#8b5cf6', label: `Orch ${orch}ms` },
          ...(ttft > 0 ? [{ width: Math.max(3, ttft * scale), color: '#2563eb', label: `TTFT ${ttft}ms` }] : []),
          ...(msgRem > 0 ? [{ width: Math.max(3, msgRem * scale), color: '#a21caf', label: `Msg Rem ${msgRem}ms` }] : []),
        ]}
        duration={orch + ttft + msgRem}
      />

      {/* Bar: Tool (orange) - separate from LLM */}
      {toolMs > 0 && (
        <BarRow
          label="Tool"
          icon="tool"
          segments={[{ width: Math.max(5, toolMs * scale), color: '#f97316', label: `${toolMs}ms` }]}
          duration={toolMs}
        />
      )}

      {/* Bar: Agent Response (teal) - agent response duration */}
      {agentSeg && customerSeg && (
        <BarRow
          label="Agent Response"
          icon="speaker"
          segments={[{ width: Math.min(100, (agentSeg.endOffsetMillis - agentSeg.beginOffsetMillis) * scale), color: '#0d9488', label: `${agentSeg.endOffsetMillis - agentSeg.beginOffsetMillis}ms` }]}
          duration={agentSeg.endOffsetMillis - agentSeg.beginOffsetMillis}
        />
      )}

      {/* Token info */}
      <div style={{ marginTop: 8, fontSize: 11, color: '#9ca3af' }}>
        Tokens: {turn.inputTokens || 0} in / {turn.outputTokens || 0} out
        {turn.cacheReadTokens > 0 && ` | Cache Read: ${turn.cacheReadTokens}`}
        {turn.cacheWriteTokens > 0 && ` | Cache Write: ${turn.cacheWriteTokens}`}
      </div>

      {/* Expandable Conversation Details */}
      {(customerSeg || agentSeg) && (
        <ExpandableSection headerText="Show Conversation Details" variant="footer">
          <div style={{ padding: '8px 0' }}>
            {/* Customer message */}
            {customerSeg && customerSeg.content && (
              <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
                <div style={{ width: 36, height: 36, borderRadius: '50%', background: '#e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <span style={{ fontSize: 16 }}>&#128100;</span>
                </div>
                <div style={{ background: '#f3f4f6', borderRadius: 12, padding: '10px 14px', maxWidth: '70%' }}>
                  <div style={{ fontSize: 13, color: '#1f2937' }}>"{customerSeg.content}"</div>
                  <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>
                    &#9998; {customerSeg.endOffsetMillis - customerSeg.beginOffsetMillis}ms
                  </div>
                </div>
              </div>
            )}
            {/* Agent response */}
            {agentSeg && agentSeg.content && (
              <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
                <div style={{ background: '#eff6ff', borderRadius: 12, padding: '10px 14px', maxWidth: '70%' }}>
                  <div style={{ fontSize: 13, color: '#1f2937' }}>"{agentSeg.content}"</div>
                  <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>
                    Orch: {orch}ms + TTFT: {ttft}ms &middot; &#128227; {agentSeg.endOffsetMillis - agentSeg.beginOffsetMillis}ms
                  </div>
                </div>
                <div style={{ width: 36, height: 36, borderRadius: '50%', background: '#dbeafe', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <span style={{ fontSize: 16 }}>&#129302;</span>
                </div>
              </div>
            )}
          </div>
        </ExpandableSection>
      )}
    </div>
  );
}

function BarRow({ label, icon, segments, duration, prefix = '' }: {
  label: string; icon: string; segments: { width: number; color: string; label?: string }[];
  duration: number; prefix?: string;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6, gap: 8 }}>
      <div style={{ width: 180, fontSize: 12, color: '#6b7280', flexShrink: 0, fontWeight: 500 }}>{label}</div>
      <div style={{ flex: 1, display: 'flex', height: 26, borderRadius: 6, overflow: 'hidden', background: '#f1f5f9' }}>
        {segments.map((seg, i) => (
          <div
            key={i}
            className="bar-segment"
            style={{
              width: `${Math.min(seg.width, 100)}%`,
              minWidth: seg.label ? 60 : 4,
              background: seg.color,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#fff',
              fontSize: 10,
              fontWeight: 600,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              borderRadius: i === 0 ? '6px 0 0 6px' : i === segments.length - 1 ? '0 6px 6px 0' : '0',
            }}
            title={seg.label || label}
          >
            {seg.label || ''}
          </div>
        ))}
      </div>
      <div style={{ width: 80, fontSize: 12, color: '#374151', textAlign: 'right', flexShrink: 0 }}>
        {prefix}{duration > 0 ? `${duration.toLocaleString()}ms` : '-'}
      </div>
    </div>
  );
}

/** Summary stat card showing AVG / FASTEST / SLOWEST for a latency metric. */
function StatCard({ title, bg, border, titleColor, avg, min, max }: {
  title: string; bg: string; border: string; titleColor: string;
  avg: number | null; min: number | null; max: number | null;
}) {
  const fmt = (v: number | null) => (v != null ? `${v.toLocaleString()}ms` : 'N/A');
  return (
    <div style={{ background: bg, borderRadius: 8, padding: 16, border: `1px solid ${border}` }}>
      <div style={{ fontWeight: 600, color: titleColor, marginBottom: 8, minHeight: 34 }}>{title}</div>
      <ColumnLayout columns={3}>
        <div>
          <div style={{ fontSize: 11, color: '#6b7280' }}>AVG</div>
          <div style={{ fontSize: 20, fontWeight: 700 }}>{fmt(avg)}</div>
        </div>
        <div>
          <div style={{ fontSize: 11, color: '#16a34a' }}>FASTEST</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: '#16a34a' }}>{fmt(min)}</div>
        </div>
        <div>
          <div style={{ fontSize: 11, color: '#dc2626' }}>SLOWEST</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: '#dc2626' }}>{fmt(max)}</div>
        </div>
      </ColumnLayout>
    </div>
  );
}

/** Documentation Tab */
function DocumentationTab() {
  return (
    <SpaceBetween size="l">
      <Alert type="info" header="Data Privacy Notice">
        This tool processes and stores customer conversation data from Amazon Connect contact center interactions, including speech transcripts, PII mismatch detection results (emails, phone numbers, account numbers), and LLM input/output messages. Data is stored in DynamoDB with a 30-day TTL. Deployers are responsible for compliance with applicable data protection regulations (GDPR, HIPAA, CCPA, PCI-DSS) when handling real customer data. Refer to the AWS Shared Responsibility Model for guidance.
      </Alert>
      <Container header={<Header variant="h2">Latency Calculation Formulas</Header>}>
        <SpaceBetween size="m">
          <div>
            <Box variant="h4">Customer Perceived Wait</Box>
            <Box variant="code">Customer Perceived Wait = Speech Processing + Orchestration + TTFT</Box>
            <Box variant="p" color="text-body-secondary">The silence the customer actually perceives, from when they stop speaking to when they start hearing the agent. Msg Remainder is NOT included — post-first-token generation overlaps the streaming of early audio, so it is shown separately as LLM detail. This reconciles to the real Contact Lens silence for the turn.</Box>
          </div>
          <div>
            <Box variant="h4">Speech Processing</Box>
            <Box variant="code">Speech Processing = full_silence - (Orchestration + TTFT)</Box>
            <Box variant="p" color="text-body-secondary">The non-LLM-to-first-token portion of the customer's silence — this combines speech-to-text (STT), VAD, routing, and text-to-speech (TTS) / audio delivery into a single, always-available metric. True per-component STT vs TTS is NOT measurable from ListSpans + Contact Lens (the Contact Lens agent-segment start lags the real streaming audio start by seconds, and a per-engine baseline produced inconsistent values), so STT and TTS are combined and reported together as "Speech Processing".</Box>
          </div>
          <div>
            <Box variant="h4">Msg Remainder</Box>
            <Box variant="code">Msg Remainder = TTFM - TTFT  (TTFM = inference.end - inference.start)</Box>
            <Box variant="p" color="text-body-secondary">The full LLM generation window minus TTFT — all token generation after the first token. Together, TTFT + Msg Remainder is the LLM's own response latency. It overlaps early-audio streaming and is NOT part of the customer-perceived wait.</Box>
          </div>
          <div>
            <Box variant="h4">Orchestration</Box>
            <Box variant="code">Orchestration = Inference.startTimestamp - InvokeAgent.startTimestamp</Box>
            <Box variant="p" color="text-body-secondary">Time from the invoke_agent span start to when the first inference (LLM call) begins. Includes internal routing, context preparation, and prompt assembly.</Box>
          </div>
          <div>
            <Box variant="h4">TTFT (Time to First Token)</Box>
            <Box variant="code">TTFT = inference.attributes.timeToFirstTokenMs</Box>
            <Box variant="p" color="text-body-secondary">Time from inference start to the first token generated by the LLM. Directly from the ListSpans API attributes. Requires boto3 v1.43+ for the Lambda to capture this field.</Box>
          </div>
          <div>
            <Box variant="h4">Message Remainder</Box>
            <Box variant="code">Remainder = Inference Duration - TTFT</Box>
            <Box variant="p" color="text-body-secondary">Time to complete token generation after the first token. The LLM is streaming the rest of the response.</Box>
          </div>
          <div>
            <Box variant="h4">LLM Total</Box>
            <Box variant="code">LLM = Orchestration + Inference Duration (TTFT + Remainder)</Box>
            <Box variant="p" color="text-body-secondary">Total LLM processing time from invoke start to inference completion. Does NOT include tool execution time.</Box>
          </div>
          <div>
            <Box variant="h4">Tool Execution</Box>
            <Box variant="code">Tool = execute_tool.endTimestamp - execute_tool.startTimestamp</Box>
            <Box variant="p" color="text-body-secondary">Duration of external tool invocations (KB retrieval, Lambda actions). For tool turns, the pattern is: Inference1 (decides tool) → Tool → Inference2 (generates response with results).</Box>
          </div>
        </SpaceBetween>
      </Container>

      <Container header={<Header variant="h2">Turn Categories &amp; Anomaly Detection</Header>}>
        <SpaceBetween size="m">
          <div>
            <Box variant="h4">Normal</Box>
            <Box variant="p" color="text-body-secondary">Clean turn with valid Contact Lens data. STT, Orchestration, TTFT, Msg Remainder and a per-engine TTS baseline are computed and reconcile to the real customer silence.</Box>
          </div>
          <div>
            <Box variant="h4">Customer Barge-in</Box>
            <Box variant="p" color="text-body-secondary">Detected when previous agent segment endOffsetMillis &gt; current customer segment beginOffsetMillis. Customer interrupted the agent. STT+TTS still calculated using orch+TTFT when available.</Box>
          </div>
          <div>
            <Box variant="h4">Agent Barge-in</Box>
            <Box variant="p" color="text-body-secondary">Detected when an agent segment starts while the customer is still speaking. Agent interrupted the customer.</Box>
          </div>
          <div>
            <Box variant="h4">Customer Pause</Box>
            <Box variant="p" color="text-body-secondary">Detected when gap between previous agent end and current customer start &gt; 5 seconds. Customer took a long time to respond (thinking, doing something).</Box>
          </div>
          <div>
            <Box variant="h4">No CL Match</Box>
            <Box variant="p" color="text-body-secondary">Turn has span data but no corresponding Contact Lens transcript segment. Happens when there are more invoke_agent spans than transcript entries (call ended during processing, or internal retries).</Box>
          </div>
          <div>
            <Box variant="h4">Tool Classification (3 strategies)</Box>
            <Box variant="p" color="text-body-secondary">
              <strong>1P (First-Party/Internal):</strong> Control tools like Escalate, Complete, Transfer. Detected via span type (INTERNAL), tool name matching (18 known names), or argument semantic analysis (escalation/transfer patterns).
              <br /><strong>3P (Third-Party/External):</strong> KB retrieval, Lambda functions, API calls. Everything not matching 1P patterns.
            </Box>
          </div>
          <div>
            <Box variant="h4">PII Mismatch Detection</Box>
            <Box variant="p" color="text-body-secondary">Uses ListSpans data only: compares inputMessages (customer speech as captured by STT) against outputMessages (agent's response from the LLM). Detects when emails, phone numbers, account numbers, or spelled words differ between what the customer said and what the agent echoed back. Does NOT use Contact Lens transcript.</Box>
          </div>
        </SpaceBetween>
      </Container>

      <Container header={<Header variant="h2">Data Pipeline Architecture</Header>}>
        <SpaceBetween size="m">
          <div>
            <Box variant="h4">Flow</Box>
            <Box variant="code">Call Ends → Recording to S3 → Contact Lens (5-10 min) → Analysis JSON to S3 → Lambda Trigger → DynamoDB</Box>
          </div>
          <div>
            <Box variant="h4">Lambda Pipeline Steps</Box>
            <Box variant="p" color="text-body-secondary">
              1. <strong>Sync Agents</strong> — Refresh AI agent list from QConnect to DynamoDB agents table<br />
              2. <strong>Download Contact Lens</strong> — Parse transcript timing (beginOffset, endOffset, participant)<br />
              3. <strong>Correlate Session</strong> — Query CloudWatch Logs for session_id matching contactId<br />
              4. <strong>Retrieve Spans</strong> — Call ListSpans API for invoke_agent, inference, execute_tool spans<br />
              5. <strong>Calculate Metrics</strong> — Per-turn breakdown, STT+TTS, categories, PII detection<br />
              6. <strong>Resolve Agent</strong> — Look up agent name from cached agents table<br />
              7. <strong>Resolve Voice</strong> — Query Connect Contact Flow logs for SetVoice event<br />
              8. <strong>Write Record</strong> — Single consolidated DynamoDB item per contact
            </Box>
          </div>
          <div>
            <Box variant="h4">DynamoDB Schema</Box>
            <Box variant="p" color="text-body-secondary">
              <strong>Primary Key:</strong> contactId (String)<br />
              <strong>GSI 1:</strong> assistantId-index (hash=assistantId, range=timestamp) — date range queries<br />
              <strong>GSI 2:</strong> agentName-index (hash=agentName, range=timestamp) — agent-filtered queries<br />
              <strong>TTL:</strong> expiresAt (30 days)
            </Box>
          </div>
        </SpaceBetween>
      </Container>

      <Container header={<Header variant="h2">Setup &amp; Dependencies</Header>}>
        <SpaceBetween size="m">
          <div>
            <Box variant="h4">Prerequisites</Box>
            <Box variant="p" color="text-body-secondary">
              - AWS CLI v2+<br />
              - Node.js v18+ with npm<br />
              - Python 3.14+ with pip<br />
              - Amazon Connect instance with Contact Lens + QConnect enabled
            </Box>
          </div>
          <div>
            <Box variant="h4">Deploy</Box>
            <Box variant="code">./deploy.sh</Box>
            <Box variant="p" color="text-body-secondary">Packages Lambda (Python + boto3), deploys CloudFormation stack, configures S3 notifications, creates Cognito user, builds React frontend, deploys to S3/CloudFront. Prints dashboard URL and credentials.</Box>
          </div>
          <div>
            <Box variant="h4">Destroy</Box>
            <Box variant="code">./deploy.sh --destroy --auto-approve</Box>
            <Box variant="p" color="text-body-secondary">Removes all AWS resources, empties S3 (including versioned objects), deletes deployment bucket, and cleans local artifacts.</Box>
          </div>
          <div>
            <Box variant="h4">Local Development</Box>
            <Box variant="p" color="text-body-secondary">
              1. Deploy the stack first with <code>./deploy.sh</code><br />
              2. Run: <code>cd frontend &amp;&amp; npm start</code><br />
              The app connects directly to DynamoDB using Cognito credentials. No local proxy needed.
            </Box>
          </div>
          <div>
            <Box variant="h4">Required IAM Permissions (Lambda)</Box>
            <Box variant="p" color="text-body-secondary">
              - s3:GetObject (Contact Lens bucket)<br />
              - logs:StartQuery, logs:GetQueryResults, logs:DescribeLogGroups<br />
              - wisdom:ListSpans, wisdom:ListAIAgents, wisdom:GetAIAgent<br />
              - qconnect:ListSpans, qconnect:ListAIAgents<br />
              - dynamodb:PutItem, BatchWriteItem, GetItem, Query, Scan<br />
              - connect:DescribeContact, DescribeInstance<br />
              - kms:Decrypt (for QConnect encryption key)
            </Box>
          </div>
          <div>
            <Box variant="h4">Timezone</Box>
            <Box variant="p" color="text-body-secondary">
              Timezone is auto-detected from your browser and saved to localStorage. All timestamps in DynamoDB are stored as UTC. The display timezone only affects how dates are shown in the UI — it does not affect queries or calculations.
            </Box>
          </div>
        </SpaceBetween>
      </Container>

      <Container header={<Header variant="h2">Outlier &amp; Anomaly Exclusion</Header>}>
        <SpaceBetween size="m">
          <div>
            <Box variant="h4">Segment-Pairing Proximity Guard</Box>
            <Box variant="p" color="text-body-secondary">A turn is only decomposed if its customer segment and the paired agent segment are within 10 seconds of each other. Pairings beyond that (e.g. an empty-output transfer turn that would cross-match a distant segment) are skipped so transfer/queue wait is not mislabeled as STT/TTS. Barge-in turns (agent audio starts before the customer finishes) are also left undecomposed.</Box>
          </div>
          <div>
            <Box variant="h4">Aggregated Statistics: Exclude Anomalies</Box>
            <Box variant="p" color="text-body-secondary">When enabled (default), removes values exceeding 2.5x the median from percentile calculations. This filters extreme outliers that skew averages.</Box>
          </div>
          <div>
            <Box variant="h4">Interaction Analysis: Exclude Outlier Turns</Box>
            <Box variant="p" color="text-body-secondary">When enabled, hides turns with: no CL match, customer/agent barge-in, or customer wait &gt; 5 seconds. Shows clean turns only for focused analysis.</Box>
          </div>
          <div>
            <Box variant="h4">Minimum Turns Filter</Box>
            <Box variant="p" color="text-body-secondary">Contacts with fewer than 4 turns are excluded from the Available Contacts list (too short for meaningful analysis).</Box>
          </div>
        </SpaceBetween>
      </Container>
    </SpaceBetween>
  );
}

export default App;
