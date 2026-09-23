// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { fromCognitoIdentityPool } from '@aws-sdk/credential-providers';
import { CognitoUserSession } from 'amazon-cognito-identity-js';
import { config } from '../config';

let docClient: DynamoDBDocumentClient | null = null;

export function initDynamoClient(session?: CognitoUserSession) {
  const credentials = fromCognitoIdentityPool({
    identityPoolId: config.identityPoolId,
    clientConfig: { region: config.region },
    logins: session ? {
      [`cognito-idp.${config.region}.amazonaws.com/${config.userPoolId}`]: session.getIdToken().getJwtToken(),
    } : undefined,
  });

  const client = new DynamoDBClient({ region: config.region, credentials });
  docClient = DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });
}

function getClient(): DynamoDBDocumentClient {
  if (!docClient) throw new Error('DynamoDB client not initialized. Call initDynamoClient() first.');
  return docClient;
}

export interface DateRange {
  startDate: string; // ISO string
  endDate: string;   // ISO string
}

/**
 * Get contacts filtered by date range using the assistantId-index GSI.
 * If agentName is provided, uses the agentName-index GSI instead.
 * Handles DynamoDB pagination (LastEvaluatedKey) to fetch all matching results.
 */
export async function getContactsByDateRange(
  dateRange: DateRange,
  agentName?: string,
  limit: number = 100,
): Promise<any[]> {
  const allItems: any[] = [];
  let lastKey: any = undefined;

  do {
    const params: any = {
      TableName: config.dynamoTableName,
      KeyConditionExpression: agentName
        ? 'agentName = :key AND #ts BETWEEN :start AND :end'
        : 'assistantId = :key AND #ts BETWEEN :start AND :end',
      ExpressionAttributeNames: { '#ts': 'timestamp' },
      ExpressionAttributeValues: {
        ':key': agentName || config.qconnectAssistantId || 'unknown',
        ':start': dateRange.startDate,
        ':end': dateRange.endDate,
      },
      IndexName: agentName ? 'agentName-index' : 'assistantId-index',
      ScanIndexForward: false,
      Limit: limit,
      ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
    };

    const response = await getClient().send(new QueryCommand(params));
    allItems.push(...(response.Items || []));
    lastKey = response.LastEvaluatedKey;
  } while (lastKey && allItems.length < limit);

  return allItems.slice(0, limit);
}

/** Get recent contacts using the assistantId GSI (no date filter) */
export async function getRecentSessions(limit: number = 20): Promise<any[]> {
  const response = await getClient().send(new QueryCommand({
    TableName: config.dynamoTableName,
    IndexName: 'assistantId-index',
    KeyConditionExpression: 'assistantId = :aid',
    ExpressionAttributeValues: { ':aid': config.qconnectAssistantId || 'unknown' },
    ScanIndexForward: false,
    Limit: limit,
  }));
  return response.Items || [];
}

/** Get a single contact record by contactId (primary key) */
export async function getContactRecord(contactId: string): Promise<any | null> {
  const response = await getClient().send(new GetCommand({
    TableName: config.dynamoTableName,
    Key: { contactId },
  }));
  return response.Item || null;
}

/** List all contacts (scan) - useful for small datasets */
export async function getAllContacts(limit: number = 50): Promise<any[]> {
  const response = await getClient().send(new ScanCommand({
    TableName: config.dynamoTableName,
    Limit: limit,
  }));
  return response.Items || [];
}

/** Get all agents from the agents table */
export async function getAgents(): Promise<any[]> {
  const agentsTable = config.agentsTableName;
  const response = await getClient().send(new ScanCommand({
    TableName: agentsTable,
  }));
  return response.Items || [];
}
