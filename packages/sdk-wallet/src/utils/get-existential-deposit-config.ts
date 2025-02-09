import { FixedPointNumber } from '@acala-network/sdk-core';

const MAX = FixedPointNumber.fromInner('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
const ZERO = FixedPointNumber.ZERO;

type ExistentialDepositConfig = {
  [chain in string]: { [token in string]: FixedPointNumber };
};

/**
 * existential deposit is maintained manually, please ensure the config is match the current;
 */
const EXISTENTIAL_DEPOSIT: ExistentialDepositConfig = {
  acala: {
    KAR: MAX,
    KUSD: MAX,
    KSM: MAX,
    LKSM: MAX,
    ACA: new FixedPointNumber(0.1, 12),
    AUSD: new FixedPointNumber(0.1, 12),
    DOT: new FixedPointNumber(0.01, 10),
    LDOT: new FixedPointNumber(0.05, 10),
    'LC://13': new FixedPointNumber(0.01, 10),
    RENBTC: MAX,
    CASH: MAX,
    BNC: MAX,
    VSKSM: MAX,
    PHA: MAX
  },
  karura: {
    KAR: new FixedPointNumber(0.1, 12),
    KUSD: new FixedPointNumber(0.01, 12),
    KSM: new FixedPointNumber(10 * 0.00001, 12),
    LKSM: new FixedPointNumber(50 * 0.00001, 12),
    BNC: new FixedPointNumber(800 * 0.00001, 12),
    VSKSM: new FixedPointNumber(10 * 0.00001, 12),
    PHA: new FixedPointNumber(4000 * 0.00001, 12),
    ACA: MAX,
    AUSD: MAX,
    DOT: MAX,
    LDOT: MAX,
    RENBTC: MAX,
    CASH: MAX
  },
  dev: {
    KAR: new FixedPointNumber(0.1, 12),
    KUSD: new FixedPointNumber(0.01, 12),
    KSM: new FixedPointNumber(10 * 0.00001, 12),
    LKSM: new FixedPointNumber(50 * 0.00001, 12),
    ACA: new FixedPointNumber(0.1, 12),
    AUSD: new FixedPointNumber(0.1, 12),
    DOT: new FixedPointNumber(0.01, 10),
    LDOT: new FixedPointNumber(0.05, 10),
    PHA: new FixedPointNumber(4000 * 0.00001, 12),
    RENBTC: MAX,
    CASH: MAX,
    BNC: new FixedPointNumber(800 * 0.00001, 12),
    VSKSM: new FixedPointNumber(10 * 0.00001, 12)
  }
};

const normalizeNetwokrName = (name: string) => name.toLowerCase();
const normalizeCurrencyName = (name: string) => name.toUpperCase();

// get ed config, return 0 if the config doesn't set.
export const getExistentialDepositConfig = (network: string, currency: string): FixedPointNumber => {
  const config = EXISTENTIAL_DEPOSIT?.[normalizeNetwokrName(network)] || EXISTENTIAL_DEPOSIT.dev;

  return config?.[normalizeCurrencyName(currency)]?.clone() || ZERO.clone();
};
