import type { Transport } from '../transport'
import type { Balance } from '../types'

interface BalanceWire {
  balance: string
  daily_cap: string
  daily_spent: string
  daily_window_resets_at: string | null
  decimals: number
}

export class BalanceResource {
  constructor(private readonly transport: Transport) {}

  /** Read the caller's Treasury balance + daily-cap state. */
  async get(): Promise<Balance> {
    const wire = await this.transport.request<BalanceWire>('/v1/balance')
    return {
      balance: wire.balance,
      dailyCap: wire.daily_cap,
      dailySpent: wire.daily_spent,
      dailyWindowResetsAt: wire.daily_window_resets_at,
      decimals: wire.decimals,
    }
  }
}
