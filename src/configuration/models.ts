export interface PublishedIntegration { method: string; path: string; url: string }
export interface FlowIntegration { client?: string; clientMethod?: string; method?: string; path?: string; url?: string; codePath?: string; codeUrl?: string; configurationProperty?: string }
export interface ConfigurationContext {
  application: string; flow: string; publicationPath: string; flowDirectory: string;
  services: PublishedIntegration[]; externalCalls: FlowIntegration[];
  applicationRepository?: string; configurationRepository?: string;
}
export interface ConfigurationEntry {
  file: string; property: string; value: string; environment?: string; deployment: boolean;
  start: number; end: number; literal: string; format: 'properties' | 'env' | 'yaml' | 'json'; document: number;
}
export interface ConfigurationScan { root: string; entries: ConfigurationEntry[]; contents: Map<string, string>; warnings: string[] }
export interface ConfigurationChange {
  integration: string; file: string; property: string; environment: string;
  previousValue: string; newValue: string; applied: boolean;
  document: number; chain: string[]; defaultFallback?: boolean;
}
export interface ConfigurationProposal { entry: ConfigurationEntry; change: ConfigurationChange }
export interface ConfigurationPlan { proposals: ConfigurationProposal[]; warnings: string[] }
