// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
export const config = {
  region: process.env.REACT_APP_AWS_REGION || '',
  identityPoolId: process.env.REACT_APP_IDENTITY_POOL_ID || '',
  dynamoTableName: process.env.REACT_APP_DYNAMODB_TABLE_NAME || '',
  agentsTableName: process.env.REACT_APP_AGENTS_TABLE_NAME || '',
  apiMode: 'dynamodb' as const,
  connectInstanceId: process.env.REACT_APP_CONNECT_INSTANCE_ID || '',
  logGroupName: process.env.REACT_APP_LOG_GROUP_NAME || '',
  userPoolId: process.env.REACT_APP_USER_POOL_ID || '',
  userPoolClientId: process.env.REACT_APP_USER_POOL_CLIENT_ID || '',
  qconnectAssistantId: process.env.REACT_APP_QCONNECT_ASSISTANT_ID || '',
};
