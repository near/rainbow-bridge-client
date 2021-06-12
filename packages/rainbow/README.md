`@near-eth/nep141-erc20`
========================
<a href="https://www.npmjs.com/package/@near-eth/nep141-erc20"><img alt="@near-eth/nep141-erc20 Version" src="https://img.shields.io/npm/v/@near-eth/nep141-erc20"></a>

A Connector Library for sending Fungible Tokens over the Rainbow Bridge.

This is a Connector Library that integrates with [@near-eth/client]. For detailed instructions on how to use it, see the README there.

This package makes it easy for your app (or, someday, CLI) to send *Fungible Tokens* over the Rainbow Bridge, using the [Fungible Token Connector contracts](https://github.com/aurora-is-near/rainbow-token-connector). It lets you send [ERC20] Tokens (Ethereum's Fungible Token standard) over the Rainbow Bridge, where they become [NEP141] Tokens (NEAR's Fungible Token Standard), and can then be sent back again.

  [@near-eth/client]: https://www.npmjs.com/package/@near-eth/client
  [ERC20]: https://eips.ethereum.org/EIPS/eip-20
  [NEP141]: https://github.com/near/NEPs/issues/141
