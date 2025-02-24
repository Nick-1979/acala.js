/**
 * wallet sdk support to query info about token list, token balance, token price and token value
 */

import { memoize } from '@polkadot/util';
import {
  FixedPointNumber as FN,
  AnyApi,
  Token,
  MaybeCurrency,
  forceToCurrencyName,
  TokenType,
  isDexShareName,
  createLiquidCrowdloanName,
  FixedPointNumber
} from '@acala-network/sdk-core';
import { AccountInfo, Balance, RuntimeDispatchInfo } from '@polkadot/types/interfaces';
import { OrmlAccountData } from '@open-web3/orml-types/interfaces';
import { BehaviorSubject, combineLatest, Observable, of, firstValueFrom } from 'rxjs';
import { map, switchMap, shareReplay, filter } from 'rxjs/operators';
import { TokenRecord, WalletConsts, BalanceData, PresetTokens, WalletConfigs, PriceProviders } from './type';
import { ChainType, Homa, Liquidity, SDKNotReady } from '..';
import { getMaxAvailableBalance } from './utils/get-max-available-balance';
import { MarketPriceProvider } from './price-provider/market-price-provider';
import { OraclePriceProvider } from './price-provider/oracle-price-provider';
import { PriceProviderType } from './price-provider/types';
import { createTokenList } from './utils/create-token-list';
import { BaseSDK } from '../types';
import { createStorages } from './storages';
import tokenList from '../configs/token-list';
import { TokenProvider } from '../base-provider';
import { getChainType } from '../utils/get-chain-type';
import { DexPriceProvider } from './price-provider/dex-price-provider';
import { AggregateProvider } from './price-provider/aggregate-price-provider';
import { BalanceAdapter } from './balance-adapter/types';
import { AcalaBalanceAdapter } from './balance-adapter/acala';
import { CurrencyNotFound } from './errors';

export class Wallet implements BaseSDK, TokenProvider {
  private api: AnyApi;
  private priceProviders: PriceProviders;
  // readed from chain information
  private tokens$: BehaviorSubject<TokenRecord | undefined>;
  private storages: ReturnType<typeof createStorages>;
  private configs: WalletConfigs;
  private balanceAdapter: BalanceAdapter;

  // inject liquidity, homa sdk by default for easy using
  public readonly liquidity: Liquidity;
  public readonly homa: Homa;

  public isReady$: BehaviorSubject<boolean>;
  public consts!: WalletConsts;

  public constructor(
    api: AnyApi,
    configs?: WalletConfigs
    // tokenPriceFetchSource = defaultTokenPriceFetchSource,
    // priceProviders?: Record<PriceProviderType, PriceProvider>
  ) {
    this.api = api;
    this.isReady$ = new BehaviorSubject<boolean>(false);
    this.tokens$ = new BehaviorSubject<TokenRecord | undefined>(undefined);
    this.configs = {
      supportAUSD: true,
      ...configs
    };

    // we should init sdk before init price provider
    this.liquidity = new Liquidity(this.api, this);
    this.homa = new Homa(this.api, this);

    const market = new MarketPriceProvider();
    const dex = new DexPriceProvider(this.liquidity);
    const aggregate = new AggregateProvider({ market, dex });
    const oracle = new OraclePriceProvider(this.api);

    this.priceProviders = {
      [PriceProviderType.AGGREGATE]: aggregate,
      [PriceProviderType.MARKET]: market,
      [PriceProviderType.ORACLE]: oracle,
      [PriceProviderType.DEX]: dex,
      ...this.configs?.priceProviders
    };
    this.storages = createStorages(this.api);

    this.init();

    this.balanceAdapter = new AcalaBalanceAdapter({
      storages: this.storages,
      nativeCurrency: this.consts.nativeCurrency,
      wsProvider: configs?.wsProvider
    });
  }

  public get isReady(): Promise<boolean> {
    return firstValueFrom(this.isReady$.asObservable().pipe(filter((i) => i)));
  }

  private init() {
    // 1. init constants
    this.initConsts();
    // 2. init tokens information
    this.initTokens();
  }

  private initConsts() {
    this.consts = {
      runtimeChain: this.api.runtimeChain.toString(),
      nativeCurrency: this.api.registry.chainTokens[0].toString()
    };
  }

  private initTokens() {
    const chainDecimals = this.api.registry.chainDecimals;
    const chainTokens = this.api.registry.chainTokens;
    const tradingPairs$ = this.storages.tradingPairs().observable;
    const assetMetadatas$ = this.storages.assetMetadatas().observable;
    const foreignAssetLocations$ = this.storages.foreignAssetLocations().observable;

    const basicTokens = Object.fromEntries(
      chainTokens.map((token, i) => {
        const config = tokenList.getToken(token, this.consts.runtimeChain);

        if (config?.symbol === 'KUSD' && this.configs.supportAUSD) {
          return [
            token,
            new Token(token, {
              ...config,
              display: 'aUSD',
              type: TokenType.BASIC,
              decimals: chainDecimals[i] ?? 12
            })
          ];
        }

        return [
          token,
          new Token(token, {
            ...config,
            type: TokenType.BASIC,
            decimals: chainDecimals[i] ?? 12
          })
        ];
      })
    );

    // insert LCDOT if chain is acala or mandala
    if (
      (getChainType(this.consts.runtimeChain) === ChainType.ACALA ||
        getChainType(this.consts.runtimeChain) === ChainType.MANDALA) &&
      basicTokens.DOT
    ) {
      const name = createLiquidCrowdloanName(13);

      basicTokens[name] = new Token(name, {
        display: 'LCDOT',
        decimals: basicTokens.DOT.decimals,
        ed: basicTokens.DOT.ed,
        type: TokenType.LIQUID_CROWDLOAN
      });
    }

    return combineLatest({
      tradingPairs: tradingPairs$,
      assetMetadatas: assetMetadatas$,
      foreignAssetLocations: foreignAssetLocations$
    }).subscribe({
      next: ({ tradingPairs, assetMetadatas, foreignAssetLocations }) => {
        const list = createTokenList(basicTokens, tradingPairs, assetMetadatas, foreignAssetLocations);

        this.tokens$.next(list);
        this.isReady$.next(true);
      }
    });
  }

  /**
   *  @name subscribeTokens
   *  @param type
   *  @description subscirbe the token list, can filter by type
   */
  public subscribeTokens = memoize((type?: TokenType | TokenType[]): Observable<TokenRecord> => {
    return this.isReady$.pipe(
      // wait sdk isReady
      filter((i) => i),
      switchMap(() => {
        return this.tokens$.pipe(
          filter((data) => !!data),
          map((data) => {
            if (type === undefined) return data || {};

            return Object.fromEntries(
              // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
              Object.entries(data!).filter(([, value]) => {
                return Array.isArray(type) ? type.includes(value.type) : value.type === type;
              })
            );
          })
        );
      }),
      shareReplay(1)
    );
  });

  public async getTokens(type?: TokenType | TokenType[]): Promise<TokenRecord> {
    return firstValueFrom(this.subscribeTokens(type));
  }

  private tokenEeual(a: string, b: Token): boolean {
    if (this.configs.supportAUSD && (a === 'KUSD' || a === 'AUSD')) {
      return b.display === 'AUSD' || b.display === 'KUSD' || b.symbol === 'AUSD' || b.symbol === 'KUSD';
    }

    return b.display === a || b.symbol === a || b.name === a;
  }

  /**
   *  @name subscribeToken
   *  @description subscirbe the token info
   */
  public subscribeToken = memoize((target: MaybeCurrency): Observable<Token> => {
    const name = forceToCurrencyName(target);

    return this.subscribeTokens().pipe(
      map((all) => {
        // filter token by name or symbol
        const result = Object.values(all).find((item) => this.tokenEeual(name, item));

        if (!result) throw new CurrencyNotFound(name);

        return result;
      })
    );
  });

  public async getToken(target: MaybeCurrency): Promise<Token> {
    return firstValueFrom(this.subscribeToken(target));
  }

  // direct get token no need await, must be called after wallet sdk is ready
  public __getToken(target: MaybeCurrency): Token {
    const name = forceToCurrencyName(target);

    const token = Object.values(this.tokens$.value || {}).find((item) => this.tokenEeual(name, item));

    if (!token) throw new CurrencyNotFound(forceToCurrencyName(target));

    return token;
  }

  /**
   * @name subscribeBalance
   * @description subscribe `address` `token` balance info
   * @param token
   * @param address
   */
  public subscribeBalance = memoize((token: MaybeCurrency, address: string): Observable<BalanceData> => {
    return this.subscribeToken(token).pipe(switchMap((token) => this.balanceAdapter.subscribeBalance(token, address)));
  });

  public async getBalance(token: MaybeCurrency, address: string): Promise<BalanceData> {
    return firstValueFrom(this.subscribeBalance(token, address));
  }

  /**
   * @name subscribeIssuance
   * @description subscribe `token` issuance amount
   * @param token
   */
  public subscribeIssuance = memoize((token: MaybeCurrency): Observable<FN> => {
    return this.subscribeToken(token).pipe(
      switchMap((token) => {
        const storage = this.storages.issuance(token);
        const handleIssuance = (data: Balance, token: Token) => FN.fromInner(data.toString(), token.decimals);

        return storage.observable.pipe(map((data) => handleIssuance(data, token)));
      })
    );
  });

  public async getIssuance(token: MaybeCurrency): Promise<FN> {
    return firstValueFrom(this.subscribeIssuance(token));
  }

  /**
   * @name subscribeSuggestInput
   * @description subscirbe the suggest input amount for `account` `token`
   * @params token: Token
   * @params account: string
   */
  public subscribeSuggestInput = memoize(
    (
      token: MaybeCurrency,
      address: string,
      isAllowDeath: boolean,
      paymentInfo: RuntimeDispatchInfo,
      feeFactor = 1.2
    ): Observable<FN> => {
      const handleNativeResult = (accountInfo: AccountInfo, token: Token, nativeToken: Token) => {
        const providers = accountInfo.providers.toBigInt();
        const consumers = accountInfo.consumers.toBigInt();
        const nativeFreeBalance = FN.fromInner(accountInfo.data.free.toString(), nativeToken.decimals);
        // native locked balance = max(accountInfo.data.miscFrozen, accountInfo.data.feeFrozen)
        const nativeLockedBalance = FN.fromInner(accountInfo.data.miscFrozen.toString(), nativeToken.decimals).max(
          FN.fromInner(accountInfo.data.feeFrozen.toString(), nativeToken.decimals)
        );
        const ed = token.ed;
        const fee = FN.fromInner(paymentInfo.partialFee.toString(), nativeToken.decimals).mul(new FN(feeFactor));

        return getMaxAvailableBalance({
          isNativeToken: true,
          isAllowDeath,
          providers,
          consumers,
          nativeFreeBalance,
          nativeLockedBalance,
          targetFreeBalance: FN.ZERO,
          targetLockedBalance: FN.ZERO,
          ed,
          fee
        });
      };

      const handleNonNativeResult = (
        accountInfo: AccountInfo,
        tokenInfo: OrmlAccountData,
        token: Token,
        nativeToken: Token
      ) => {
        const providers = accountInfo.providers.toBigInt();
        const consumers = accountInfo.consumers.toBigInt();
        const nativeFreeBalance = FN.fromInner(accountInfo.data.free.toString(), nativeToken.decimals);
        // native locked balance = max(accountInfo.data.miscFrozen, accountInfo.data.feeFrozen)
        const nativeLockedBalance = FN.fromInner(accountInfo.data.miscFrozen.toString(), nativeToken.decimals).max(
          FN.fromInner(accountInfo.data.feeFrozen.toString(), nativeToken.decimals)
        );
        const targetFreeBalance = FN.fromInner(tokenInfo.free.toString(), token.decimals);
        const targetLockedBalance = FN.fromInner(tokenInfo.frozen.toString(), token.decimals);
        const ed = token.ed;
        const fee = FN.fromInner(paymentInfo.partialFee.toString(), nativeToken.decimals).mul(new FN(feeFactor));

        return getMaxAvailableBalance({
          isNativeToken: false,
          isAllowDeath,
          providers,
          consumers,
          nativeFreeBalance,
          nativeLockedBalance,
          targetFreeBalance,
          targetLockedBalance,
          ed,
          fee
        });
      };

      return combineLatest({
        token: this.subscribeToken(token),
        nativeToken: this.subscribeToken(this.consts.nativeCurrency)
      }).pipe(
        switchMap(({ token, nativeToken }) => {
          const isNativeToken = forceToCurrencyName(token) === nativeToken.name;

          if (isNativeToken) {
            return this.storages
              .nativeBalance(address)
              .observable.pipe(map((data) => handleNativeResult(data, token, nativeToken)));
          }

          return combineLatest({
            accountInfo: this.storages.nativeBalance(address).observable,
            tokenInfo: this.storages.nonNativeBalance(token, address).observable
          }).pipe(
            map(({ accountInfo, tokenInfo }) => handleNonNativeResult(accountInfo, tokenInfo, token, nativeToken))
          );
        })
      );
    }
  );

  public async getSuggestInput(
    token: MaybeCurrency,
    address: string,
    isAllowDeath: boolean,
    paymentInfo: RuntimeDispatchInfo,
    feeFactor = 1.2
  ): Promise<FN> {
    return firstValueFrom(this.subscribeSuggestInput(token, address, isAllowDeath, paymentInfo, feeFactor));
  }

  public getPresetTokens(): PresetTokens {
    if (this.isReady$.value === false) {
      throw new SDKNotReady('wallet');
    }

    const tokens = this.tokens$.value || {};

    const data: PresetTokens = {
      nativeToken: tokens[forceToCurrencyName(this.consts.nativeCurrency)]
    };

    if (this.api.consts?.cdpEngine.getStableCurrencyId) {
      data.stableToken = tokens[forceToCurrencyName(this.api.consts.cdpEngine.getStableCurrencyId)];
    }

    data.liquidToken =
      tokens[
        forceToCurrencyName(this.api.consts.homa?.liquidCurrencyId || this.api.consts.homaLite?.liquidCurrencyId || '')
      ];

    data.stakingToken =
      tokens[
        forceToCurrencyName(
          this.api.consts.homa?.stakingCurrencyId || this.api.consts.homaLite?.stakingCurrencyId || ''
        )
      ];

    return data;
  }

  /**
   * @name subscribePrice
   * @description subscirbe the price of `token`
   */
  public subscribePrice = memoize((token: MaybeCurrency, type = PriceProviderType.AGGREGATE): Observable<FN> => {
    const name = forceToCurrencyName(token);
    const isDexShare = isDexShareName(name);
    const presetTokens = this.getPresetTokens();
    const isLiquidToken = presetTokens?.liquidToken?.name === name;
    const stakingToken = presetTokens.stakingToken;

    // if token is dex share, get dex share price form liquidity sdk
    if (isDexShare) {
      return this.liquidity.subscribePoolDetails(name).pipe(map((data) => data.sharePrice));
    }

    // get liquid token price when price type is market or aggergate
    if (isLiquidToken && stakingToken && (type === PriceProviderType.MARKET || type === PriceProviderType.AGGREGATE)) {
      // create homa sd for get exchange rate
      return this.homa.subscribeEnv().pipe(
        filter((env) => !env.exchangeRate.isZero()),
        switchMap((env) =>
          this.subscribePrice(stakingToken, type).pipe(
            map((price) => {
              return price.times(env.exchangeRate);
            })
          )
        )
      );
    }

    if (type === PriceProviderType.MARKET && this.priceProviders[PriceProviderType.MARKET]) {
      return this.subscribeToken(token).pipe(
        switchMap(
          (token) => this.priceProviders[PriceProviderType.MARKET]?.subscribe(token) || of(FixedPointNumber.ZERO)
        )
      );
    }

    if (type === PriceProviderType.AGGREGATE && this.priceProviders[PriceProviderType.AGGREGATE]) {
      return this.subscribeToken(token).pipe(
        switchMap(
          (token) => this.priceProviders[PriceProviderType.AGGREGATE]?.subscribe(token) || of(FixedPointNumber.ZERO)
        )
      );
    }

    if (type === PriceProviderType.DEX && this.priceProviders[PriceProviderType.DEX]) {
      return this.subscribeToken(token).pipe(
        switchMap((token) => this.priceProviders[PriceProviderType.DEX]?.subscribe(token) || of(FixedPointNumber.ZERO))
      );
    }

    if (type === PriceProviderType.ORACLE && this.priceProviders[PriceProviderType.ORACLE]) {
      return this.subscribeToken(token).pipe(
        switchMap(
          (token) => this.priceProviders[PriceProviderType.ORACLE]?.subscribe(token) || of(FixedPointNumber.ZERO)
        )
      );
    }

    return of(FixedPointNumber.ZERO);
  });

  public getPrice(token: MaybeCurrency, type?: PriceProviderType): Promise<FN> {
    return firstValueFrom(this.subscribePrice(token, type));
  }
}
