/**
 * Shared types for advisor backends.
 *
 * Both the pi-ai and external-cli backends return the same `AdvisorResponse` shape so
 * the tool layer can treat them interchangeably.
 */

import type { AdvisorUsage } from "../state.ts";

export type AdvisorResponse = {
  text: string;
  usage: AdvisorUsage;
  elapsedMs: number;
  model: string;
};