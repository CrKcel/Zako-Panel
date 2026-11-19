import type { components, operations, paths } from './schema';

export type { components, operations, paths };

type Schemas = components['schemas'];

export type Meta = Schemas['Meta'];
export type ListMeta = Schemas['ListMeta'];
export type ErrorResponse = Schemas['ErrorResponse'];

export type NodeStatus = Schemas['NodeStatus'];
export type NodeStatusDetail = Schemas['NodeStatusDetail'];
export type Node = Schemas['Node'];
export type SysStats = Schemas['SysStats'];
export type Endpoint = Schemas['Endpoint'];
export type VlessRealityParams = Schemas['VlessRealityParams'];
export type ProxyGroup = Schemas['ProxyGroup'];
export type Profile = Schemas['Profile'];
export type ProfileDetail = Schemas['ProfileDetail'];
export type NodeClient = Schemas['NodeClient'];
export type ClashPreview = Schemas['ClashPreview'];
export type DistributionSkipReason = Schemas['DistributionSkipReason'];
export type SubscriberBlockReason = Schemas['SubscriberBlockReason'];
export type Subscription = Schemas['Subscription'];
export type SubscriberStatus = Schemas['SubscriberStatus'];
export type SubscriberUsage = Schemas['SubscriberUsage'];
export type Subscriber = Schemas['Subscriber'];
export type SubscriberDetail = Schemas['SubscriberDetail'];
export type TrafficGroupBy = Schemas['TrafficGroupBy'];
export type TrafficItem = Schemas['TrafficItem'];
export type TrafficSummary = Schemas['TrafficSummary'];
export type ConfigVersion = Schemas['ConfigVersion'];

export type AgentTrafficNode = Schemas['AgentTrafficNode'];
export type AgentTrafficUser = Schemas['AgentTrafficUser'];
export type AgentTraffic = Schemas['AgentTraffic'];
export type AgentReport = Schemas['AgentReport'];
export type AgentDirective = Schemas['AgentDirective'];
export type AgentReportResponse = Schemas['AgentReportResponse'];
export type AgentUser = Schemas['AgentUser'];
export type AgentUsers = Schemas['AgentUsers'];
export type AgentConfig = Schemas['AgentConfig'];
export type AgentConfigResult = Schemas['AgentConfigResult'];
export type AgentUpdateResult = Schemas['AgentUpdateResult'];
export type AgentEnrollRequest = Schemas['AgentEnrollRequest'];
export type AgentEnrollResponse = Schemas['AgentEnrollResponse'];

export type RequestNodeAgentUpdateRequest = Schemas['RequestNodeAgentUpdateRequest'];
export type NodeEnrollmentToken = Schemas['NodeEnrollmentToken'];
export type CreateNodeEnrollmentTokenRequest = Schemas['CreateNodeEnrollmentTokenRequest'];
export type UpdateNodeRequest = Schemas['UpdateNodeRequest'];
export type CreateEndpointRequest = Schemas['CreateEndpointRequest'];
export type UpdateEndpointRequest = Schemas['UpdateEndpointRequest'];
export type CreateProfileRequest = Schemas['CreateProfileRequest'];
export type UpdateProfileRequest = Schemas['UpdateProfileRequest'];
export type CreateSubscriptionRequest = Schemas['CreateSubscriptionRequest'];
export type CreateSubscriberRequest = Schemas['CreateSubscriberRequest'];
export type UpdateSubscriberRequest = Schemas['UpdateSubscriberRequest'];
export type ReplaceSubscriberNodesRequest = Schemas['ReplaceSubscriberNodesRequest'];
export type PublishConfigRequest = Schemas['PublishConfigRequest'];
