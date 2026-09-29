'use client';

import { IndentPlugin } from '@platejs/indent/react';

import { INDENT_CONFIG } from './config';

export const IndentKit = [IndentPlugin.configure(INDENT_CONFIG)];
