// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import React, { useState } from 'react';
import {
  CognitoUserPool,
  CognitoUser,
  AuthenticationDetails,
} from 'amazon-cognito-identity-js';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import FormField from '@cloudscape-design/components/form-field';
import Input from '@cloudscape-design/components/input';
import Button from '@cloudscape-design/components/button';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import { config } from '../config';

const userPool = new CognitoUserPool({
  UserPoolId: config.userPoolId,
  ClientId: config.userPoolClientId,
});

interface CognitoAuthProps {
  onAuthenticated: (user: CognitoUser) => void;
}

export function CognitoAuth({ onAuthenticated }: CognitoAuthProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [challengeUser, setChallengeUser] = useState<CognitoUser | null>(null);
  const [requireNewPassword, setRequireNewPassword] = useState(false);

  const handleLogin = () => {
    setLoading(true);
    setError(null);

    const cognitoUser = new CognitoUser({
      Username: email,
      Pool: userPool,
    });

    const authDetails = new AuthenticationDetails({
      Username: email,
      Password: password,
    });

    cognitoUser.authenticateUser(authDetails, {
      onSuccess: () => {
        setLoading(false);
        onAuthenticated(cognitoUser);
      },
      onFailure: (err) => {
        setLoading(false);
        setError(err.message || 'Authentication failed');
      },
      newPasswordRequired: () => {
        setLoading(false);
        setChallengeUser(cognitoUser);
        setRequireNewPassword(true);
      },
    });
  };

  const handleNewPassword = () => {
    if (!challengeUser || !newPassword) return;
    setLoading(true);
    setError(null);

    challengeUser.completeNewPasswordChallenge(newPassword, {}, {
      onSuccess: () => {
        setLoading(false);
        onAuthenticated(challengeUser);
      },
      onFailure: (err) => {
        setLoading(false);
        setError(err.message || 'Failed to set new password');
      },
    });
  };

  if (requireNewPassword) {
    return (
      <Box margin={{ top: 'xxxl' }} padding="xxxl">
        <Container header={<Header variant="h2">Set New Password</Header>}>
          <SpaceBetween size="m">
            <Alert type="info">
              You must set a new password before continuing.
            </Alert>
            {error && <Alert type="error">{error}</Alert>}
            <FormField label="New Password">
              <Input
                type="password"
                value={newPassword}
                onChange={({ detail }) => setNewPassword(detail.value)}
                placeholder="Enter new password"
              />
            </FormField>
            <Button variant="primary" onClick={handleNewPassword} loading={loading}>
              Set Password & Continue
            </Button>
          </SpaceBetween>
        </Container>
      </Box>
    );
  }

  return (
    <Box margin={{ top: 'xxxl' }} padding="xxxl">
      <div style={{ maxWidth: '400px', margin: '0 auto' }}>
        <Container
          header={
            <Header variant="h2" description="Sign in to access the analyzer dashboard">
              Amazon Connect AI Agent Analyzer
            </Header>
          }
        >
          <SpaceBetween size="m">
            {error && <Alert type="error" dismissible onDismiss={() => setError(null)}>{error}</Alert>}
            <FormField label="Email">
              <Input
                type="email"
                value={email}
                onChange={({ detail }) => setEmail(detail.value)}
                placeholder="you@example.com"
                onKeyDown={(e) => { if (e.detail.key === 'Enter') handleLogin(); }}
              />
            </FormField>
            <FormField label="Password">
              <Input
                type="password"
                value={password}
                onChange={({ detail }) => setPassword(detail.value)}
                placeholder="Enter password"
                onKeyDown={(e) => { if (e.detail.key === 'Enter') handleLogin(); }}
              />
            </FormField>
            <Button variant="primary" onClick={handleLogin} loading={loading} fullWidth>
              Sign In
            </Button>
          </SpaceBetween>
        </Container>
      </div>
    </Box>
  );
}

export function getCurrentUser(): CognitoUser | null {
  return userPool.getCurrentUser();
}

export function signOut() {
  const user = userPool.getCurrentUser();
  if (user) {
    user.signOut();
  }
}

export function getSession(): Promise<any> {
  return new Promise((resolve, reject) => {
    const user = userPool.getCurrentUser();
    if (!user) {
      reject(new Error('No authenticated user'));
      return;
    }
    user.getSession((err: any, session: any) => {
      if (err) reject(err);
      else resolve(session);
    });
  });
}
