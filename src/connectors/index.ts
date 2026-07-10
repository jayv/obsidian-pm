import type { ConnectorDescriptor } from './registry'
import { jiraConnector } from './jira/JiraConnector'

/**
 * The connectors available to the plugin. main.ts registers these without
 * naming any concrete connector; adding one is a single line here. Descriptors
 * are cheap — the actual connector is built lazily on first use.
 */
export const CONNECTORS: ConnectorDescriptor[] = [jiraConnector]
