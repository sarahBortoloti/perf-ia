export interface JavaAnnotation {
  name: string;
  attributes: Record<string, string[]>;
}
export interface Endpoint {
  methodName: string;
  httpMethod: string;
  path: string;
}
export interface JavaComponent {
  name: string;
  packageName: string;
  filePath: string;
  annotations: JavaAnnotation[];
}
export interface Controller extends JavaComponent {
  endpoints: Endpoint[];
}
export interface FeignClient extends JavaComponent {
  clientName?: string;
  url?: string;
  paths: string[];
  endpoints: Endpoint[];
}
export interface ConfigurationFile {
  filePath: string;
  format: 'properties' | 'yaml';
  content: string;
}
export interface RepositoryAnalysis {
  repositoryPath: string;
  controllers: Controller[];
  services: JavaComponent[];
  feignClients: FeignClient[];
  configurationFiles: ConfigurationFile[];
}
