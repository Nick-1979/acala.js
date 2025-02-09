import { Chain, CrossChainRouter, CrossChainInputConfigs, CrossChainTransferParams } from './types';
import { RegisteredChain } from './configs/chains';
import { AnyApi, FixedPointNumber } from '@acala-network/sdk-core';
import { combineLatest, Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { SubmittableExtrinsic } from '@polkadot/api/types';
import { TokenBalance } from '../types';

export abstract class BaseCrossChainAdapter {
  protected routers: Omit<CrossChainRouter, 'from'>[];
  protected api!: AnyApi;
  readonly chain: Chain;
  private findAdapter!: (chain: Chain | RegisteredChain) => BaseCrossChainAdapter;

  constructor(api: AnyApi, chain: Chain, routers: Omit<CrossChainRouter, 'from'>[]) {
    this.api = api;
    this.chain = chain;
    this.routers = routers;
  }

  public injectFindAdapter(func: (chain: RegisteredChain | Chain) => BaseCrossChainAdapter): void {
    this.findAdapter = func;
  }

  public getRouters(): CrossChainRouter[] {
    return this.routers.map((i) => ({ ...i, from: this.chain }));
  }

  public getSS58Prefix(): number {
    return Number(this.api.registry.chainSS58?.toString());
  }

  public subscribeInputConfigs(params: Omit<CrossChainTransferParams, 'amount'>): Observable<CrossChainInputConfigs> {
    const { to, token, address } = params;
    const toAdapter = this.findAdapter(to);

    // subscribe destination min receive
    const crossChainFee = toAdapter.getCrossChainFee(token);
    const minInput$ = toAdapter.subscribeMinInput(token);
    const maxInput$ = this.subscribeMaxInput(token, address);

    return combineLatest({
      minInput: minInput$,
      maxInput: maxInput$
    }).pipe(
      map(({ minInput, maxInput }) => {
        return {
          minInput,
          maxInput,
          ss58Prefix: toAdapter.getSS58Prefix(),
          destCrossChainFee: crossChainFee,
          tokenDecimals: toAdapter.getCrossChainTokenDecimals(token)
        };
      })
    );
  }

  public abstract subscribeAvailableBalance(token: string, address: string): Observable<FixedPointNumber>;
  public abstract subscribeMinInput(token: string): Observable<FixedPointNumber>;
  public abstract subscribeMaxInput(token: string, address: string): Observable<FixedPointNumber>;
  public abstract getCrossChainFee(token: string): TokenBalance;
  public abstract getCrossChainTokenDecimals(token: string): number;
  public abstract createTx(
    params: CrossChainTransferParams
  ): SubmittableExtrinsic<'promise'> | SubmittableExtrinsic<'rxjs'>;
}
