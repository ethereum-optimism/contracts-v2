import { expect } from '../../../setup'

/* External Imports */
import { ethers } from '@nomiclabs/buidler'
import { Signer, ContractFactory, Contract, BigNumber, providers } from 'ethers'
import { TransactionResponse } from '@ethersproject/abstract-provider'
import { smockit, MockContract } from '@eth-optimism/smock'
import _, { times } from 'lodash'

/* Internal Imports */
import {
  makeAddressManager,
  setProxyTarget,
  FORCE_INCLUSION_PERIOD_SECONDS,
  FORCE_INCLUSION_PERIOD_BLOCKS,
  setEthTime,
  NON_ZERO_ADDRESS,
  remove0x,
  getEthTime,
  getNextBlockNumber,
  increaseEthTime,
  getBlockTime,
  ZERO_ADDRESS,
} from '../../../helpers'
import { defaultAbiCoder, keccak256 } from 'ethers/lib/utils'

const ELEMENT_TEST_SIZES = [1, 2, 4, 8, 16]
const DECOMPRESSION_ADDRESS = '0x4200000000000000000000000000000000000008'
const MAX_GAS_LIMIT = 8_000_000

const getQueueLeafHash = (index: number): string => {
  return keccak256(
    defaultAbiCoder.encode(
      ['bool', 'uint256', 'uint256', 'uint256', 'bytes'],
      [false, index, 0, 0, '0x']
    )
  )
}

const getSequencerLeafHash = (
  timestamp: number,
  blockNumber: number,
  data: string
): string => {
  return keccak256(
    '0x01' +
      remove0x(BigNumber.from(timestamp).toHexString()).padStart(64, '0') +
      remove0x(BigNumber.from(blockNumber).toHexString()).padStart(64, '0') +
      remove0x(data)
  )
}

const getTransactionHash = (
  sender: string,
  target: string,
  gasLimit: number,
  data: string
): string => {
  return keccak256(encodeQueueTransaction(sender, target, gasLimit, data))
}

const encodeQueueTransaction = (
  sender: string,
  target: string,
  gasLimit: number,
  data: string
): string => {
  return defaultAbiCoder.encode(
    ['address', 'address', 'uint256', 'bytes'],
    [sender, target, gasLimit, data]
  )
}

interface BatchContext {
  numSequencedTransactions: number
  numSubsequentQueueTransactions: number
  timestamp: number
  blockNumber: number
}

interface AppendSequencerBatchParams {
  shouldStartAtElement: number // 5 bytes -- starts at batch
  totalElementsToAppend: number // 3 bytes -- total_elements_to_append
  contexts: BatchContext[] // total_elements[fixed_size[]]
  transactions: string[] // total_size_bytes[],total_size_bytes[]
}

const encodeAppendSequencerBatch = (b: AppendSequencerBatchParams): string => {
  const encodedShouldStartAtElement = remove0x(
    BigNumber.from(b.shouldStartAtElement).toHexString()
  ).padStart(10, '0')

  const encodedTotalElementsToAppend = remove0x(
    BigNumber.from(b.totalElementsToAppend).toHexString()
  ).padStart(6, '0')

  
  const encodedContextsHeader = remove0x(
    BigNumber.from(b.contexts.length).toHexString()
  ).padStart(6, '0')

  const encodedContexts =
    encodedContextsHeader +
    b.contexts.reduce((acc, cur) => acc + encodeBatchContext(cur), '')

  const encodedTransactionData = b.transactions.reduce((acc, cur) => {
    if (cur.length % 2 !== 0)
      throw new Error('Unexpected uneven hex string value!')
    const encodedTxDataHeader = remove0x(
      BigNumber.from(remove0x(cur).length / 2).toHexString()
    ).padStart(6, '0')
    return acc + encodedTxDataHeader + remove0x(cur)
  }, '')

  return (
    encodedShouldStartAtElement +
    encodedTotalElementsToAppend +
    encodedContexts +
    encodedTransactionData
  )
}

const appendSequencerBatch = async (
  OVM_CanonicalTransactionChain: Contract,
  batch: AppendSequencerBatchParams
): Promise<TransactionResponse> => {
  const methodId = keccak256(Buffer.from('appendSequencerBatch()')).slice(2, 10)
  const calldata = encodeAppendSequencerBatch(batch)
  return OVM_CanonicalTransactionChain.signer.sendTransaction({
    to: OVM_CanonicalTransactionChain.address,
    data: '0x' + methodId + calldata,
  })
}

const encodeBatchContext = (context: BatchContext): string => {
  return (
    remove0x(
      BigNumber.from(context.numSequencedTransactions).toHexString()
    ).padStart(6, '0') +
    remove0x(
      BigNumber.from(context.numSubsequentQueueTransactions).toHexString()
    ).padStart(6, '0') +
    remove0x(BigNumber.from(context.timestamp).toHexString()).padStart(
      10,
      '0'
    ) +
    remove0x(BigNumber.from(context.blockNumber).toHexString()).padStart(
      10,
      '0'
    )
  )
}

describe('OVM_CanonicalTransactionChain', () => {
  let signer: Signer
  let sequencer: Signer
  before(async () => {
    ;[signer, sequencer] = await ethers.getSigners()
  })

  let AddressManager: Contract
  let Mock__OVM_ExecutionManager: MockContract
  let Mock__OVM_StateCommitmentChain: MockContract
  before(async () => {
    AddressManager = await makeAddressManager()
    await AddressManager.setAddress(
      'OVM_Sequencer',
      await sequencer.getAddress()
    )
    await AddressManager.setAddress(
      'OVM_DecompressionPrecompileAddress',
      DECOMPRESSION_ADDRESS
    )

    Mock__OVM_ExecutionManager = smockit(
      await ethers.getContractFactory('OVM_ExecutionManager')
    )

    Mock__OVM_StateCommitmentChain = smockit(
      await ethers.getContractFactory('OVM_StateCommitmentChain')
    )

    await setProxyTarget(
      AddressManager,
      'OVM_ExecutionManager',
      Mock__OVM_ExecutionManager
    )

    await setProxyTarget(
      AddressManager,
      'OVM_StateCommitmentChain',
      Mock__OVM_StateCommitmentChain
    )

    Mock__OVM_StateCommitmentChain.smocked.canOverwrite.will.return.with(false)
    Mock__OVM_ExecutionManager.smocked.getMaxTransactionGasLimit.will.return.with(
      MAX_GAS_LIMIT
    )
  })

  let Factory__OVM_CanonicalTransactionChain: ContractFactory
  before(async () => {
    Factory__OVM_CanonicalTransactionChain = await ethers.getContractFactory(
      'OVM_CanonicalTransactionChain'
    )
  })

  let OVM_CanonicalTransactionChain: Contract
  beforeEach(async () => {
    OVM_CanonicalTransactionChain = await Factory__OVM_CanonicalTransactionChain.deploy(
      AddressManager.address,
      FORCE_INCLUSION_PERIOD_SECONDS,
      FORCE_INCLUSION_PERIOD_BLOCKS
    )
    await OVM_CanonicalTransactionChain.init()
  })

  describe('enqueue', () => {
    const target = NON_ZERO_ADDRESS
    const gasLimit = 500_000
    const data = '0x' + '12'.repeat(1234)

    it('should revert when trying to input more data than the max data size', async () => {
      const MAX_ROLLUP_TX_SIZE = await OVM_CanonicalTransactionChain.MAX_ROLLUP_TX_SIZE()
      const data = '0x' + '12'.repeat(MAX_ROLLUP_TX_SIZE + 1)

      await expect(
        OVM_CanonicalTransactionChain.enqueue(target, gasLimit, data)
      ).to.be.revertedWith(
        'Transaction exceeds maximum rollup transaction data size.'
      )
    })

    it('should revert if gas limit parameter is not at least MIN_ROLLUP_TX_GAS', async () => {
      const MIN_ROLLUP_TX_GAS = await OVM_CanonicalTransactionChain.MIN_ROLLUP_TX_GAS()
      const gasLimit = MIN_ROLLUP_TX_GAS / 2

      await expect(
        OVM_CanonicalTransactionChain.enqueue(target, gasLimit, data)
      ).to.be.revertedWith('Transaction gas limit too low to enqueue.')
    })

    it('should revert if transaction gas limit does not cover rollup burn', async () => {
      const L2_GAS_DISCOUNT_DIVISOR = await OVM_CanonicalTransactionChain.L2_GAS_DISCOUNT_DIVISOR()

      await expect(
        OVM_CanonicalTransactionChain.enqueue(target, gasLimit, data, {
          gasLimit: gasLimit / L2_GAS_DISCOUNT_DIVISOR - 1,
        })
      ).to.be.revertedWith('Insufficient gas for L2 rate limiting burn.')
    })

    describe('with valid input parameters', () => {
      it('should emit a TransactionEnqueued event', async () => {
        const timestamp = (await getEthTime(ethers.provider)) + 100
        await setEthTime(ethers.provider, timestamp)

        await expect(
          OVM_CanonicalTransactionChain.enqueue(target, gasLimit, data)
        ).to.emit(OVM_CanonicalTransactionChain, 'TransactionEnqueued')
      })

      describe('when enqueing multiple times', () => {
        for (const size of ELEMENT_TEST_SIZES) {
          it(`should be able to enqueue ${size} elements`, async () => {
            for (let i = 0; i < size; i++) {
              await expect(
                OVM_CanonicalTransactionChain.enqueue(target, gasLimit, data)
              ).to.not.be.reverted
            }
          })
        }
      })
    })
  })

  describe('getQueueElement', () => {
    it('should revert when accessing a non-existent element', async () => {
      await expect(
        OVM_CanonicalTransactionChain.getQueueElement(0)
      ).to.be.revertedWith('Index out of bounds.')
    })

    describe('when the requested element exists', () => {
      const target = NON_ZERO_ADDRESS
      const gasLimit = 500_000
      const data = '0x' + '12'.repeat(1234)

      describe('when getting the first element', () => {
        for (const size of ELEMENT_TEST_SIZES) {
          it(`gets the element when ${size} + 1 elements exist`, async () => {
            const timestamp = (await getEthTime(ethers.provider)) + 100
            const blockNumber = await getNextBlockNumber(ethers.provider)
            await setEthTime(ethers.provider, timestamp)

            const queueRoot = getTransactionHash(
              await signer.getAddress(),
              target,
              gasLimit,
              data
            )

            await OVM_CanonicalTransactionChain.enqueue(target, gasLimit, data)

            for (let i = 0; i < size; i++) {
              await OVM_CanonicalTransactionChain.enqueue(
                target,
                gasLimit,
                '0x' + '12'.repeat(i + 1)
              )
            }

            expect(
              _.toPlainObject(
                await OVM_CanonicalTransactionChain.getQueueElement(0)
              )
            ).to.deep.include({
              queueRoot,
              timestamp,
              blockNumber,
            })
          })
        }
      })

      describe('when getting the middle element', () => {
        for (const size of ELEMENT_TEST_SIZES) {
          it(`gets the element when ${size} elements exist`, async () => {
            let timestamp: number
            let blockNumber: number
            let queueRoot: string

            const middleIndex = Math.floor(size / 2)
            for (let i = 0; i < size; i++) {
              if (i === middleIndex) {
                timestamp = (await getEthTime(ethers.provider)) + 100
                blockNumber = await getNextBlockNumber(ethers.provider)
                await setEthTime(ethers.provider, timestamp)

                queueRoot = getTransactionHash(
                  await signer.getAddress(),
                  target,
                  gasLimit,
                  data
                )

                await OVM_CanonicalTransactionChain.enqueue(
                  target,
                  gasLimit,
                  data
                )
              } else {
                await OVM_CanonicalTransactionChain.enqueue(
                  target,
                  gasLimit,
                  '0x' + '12'.repeat(i + 1)
                )
              }
            }

            expect(
              _.toPlainObject(
                await OVM_CanonicalTransactionChain.getQueueElement(middleIndex)
              )
            ).to.deep.include({
              queueRoot,
              timestamp,
              blockNumber,
            })
          })
        }
      })

      describe('when getting the last element', () => {
        for (const size of ELEMENT_TEST_SIZES) {
          it(`gets the element when ${size} elements exist`, async () => {
            let timestamp: number
            let blockNumber: number
            let queueRoot: string

            for (let i = 0; i < size; i++) {
              if (i === size - 1) {
                timestamp = (await getEthTime(ethers.provider)) + 100
                blockNumber = await getNextBlockNumber(ethers.provider)
                await setEthTime(ethers.provider, timestamp)

                queueRoot = getTransactionHash(
                  await signer.getAddress(),
                  target,
                  gasLimit,
                  data
                )

                await OVM_CanonicalTransactionChain.enqueue(
                  target,
                  gasLimit,
                  data
                )
              } else {
                await OVM_CanonicalTransactionChain.enqueue(
                  target,
                  gasLimit,
                  '0x' + '12'.repeat(i + 1)
                )
              }
            }

            expect(
              _.toPlainObject(
                await OVM_CanonicalTransactionChain.getQueueElement(size - 1)
              )
            ).to.deep.include({
              queueRoot,
              timestamp,
              blockNumber,
            })
          })
        }
      })
    })
  })

  describe('appendQueueBatch', () => {
    it('should revert if trying to append zero transactions', async () => {
      await expect(
        OVM_CanonicalTransactionChain.appendQueueBatch(0)
      ).to.be.revertedWith('Must append more than zero transactions.')
    })

    it('should revert if the queue is empty', async () => {
      await expect(
        OVM_CanonicalTransactionChain.appendQueueBatch(1)
      ).to.be.revertedWith('Must append more than zero transactions.')
    })

    describe('when the queue is not empty', () => {
      const target = NON_ZERO_ADDRESS
      const gasLimit = 500_000
      const data = '0x' + '12'.repeat(1234)

      for (const size of ELEMENT_TEST_SIZES) {
        describe(`when the queue has ${size} elements`, () => {
          beforeEach(async () => {
            for (let i = 0; i < size; i++) {
              await OVM_CanonicalTransactionChain.enqueue(
                target,
                gasLimit,
                data
              )
            }
          })

          describe('when the sequencer inclusion period has not passed', () => {
            it('should revert if not called by the sequencer', async () => {
              await expect(
                OVM_CanonicalTransactionChain.connect(signer).appendQueueBatch(
                  1
                )
              ).to.be.revertedWith(
                'Queue transactions cannot be submitted during the sequencer inclusion period.'
              )
            })

            it('should succeed if called by the sequencer', async () => {
              await expect(
                OVM_CanonicalTransactionChain.connect(
                  sequencer
                ).appendQueueBatch(1)
              )
                .to.emit(OVM_CanonicalTransactionChain, 'QueueBatchAppended')
                .withArgs(0, 1, 1)
            })
          })

          describe('when the sequencer inclusion period has passed', () => {
            beforeEach(async () => {
              await increaseEthTime(
                ethers.provider,
                FORCE_INCLUSION_PERIOD_SECONDS * 2
              )
            })

            it('should be able to append a single element', async () => {
              await expect(OVM_CanonicalTransactionChain.appendQueueBatch(1))
                .to.emit(OVM_CanonicalTransactionChain, 'QueueBatchAppended')
                .withArgs(0, 1, 1)
            })

            it(`should be able to append ${size} elements`, async () => {
              await expect(OVM_CanonicalTransactionChain.appendQueueBatch(size))
                .to.emit(OVM_CanonicalTransactionChain, 'QueueBatchAppended')
                .withArgs(0, size, size)
            })

            it(`should be able to append ${size} elements even if attempting to append ${size} + 1 elements`, async () => {
              await expect(
                OVM_CanonicalTransactionChain.appendQueueBatch(size + 1)
              )
                .to.emit(OVM_CanonicalTransactionChain, 'QueueBatchAppended')
                .withArgs(0, size, size)
            })
          })
        })
      }
    })
  })

  describe('verifyTransaction', () => {
    it('should successfully verify against a valid queue transaction', async () => {
      const entrypoint = NON_ZERO_ADDRESS
      const gasLimit = 500_000
      const data = '0x' + '12'.repeat(1234)

      const timestamp = (await getEthTime(ethers.provider)) + 100
      await setEthTime(ethers.provider, timestamp)
      await OVM_CanonicalTransactionChain.enqueue(entrypoint, gasLimit, data)

      const blockNumber = await ethers.provider.getBlockNumber()
      await increaseEthTime(ethers.provider, FORCE_INCLUSION_PERIOD_SECONDS * 2)

      await OVM_CanonicalTransactionChain.appendQueueBatch(1)

      expect(
        await OVM_CanonicalTransactionChain.verifyTransaction(
          {
            timestamp,
            blockNumber,
            l1QueueOrigin: 1,
            l1TxOrigin: await OVM_CanonicalTransactionChain.signer.getAddress(),
            entrypoint,
            gasLimit,
            data,
          },
          {
            isSequenced: false,
            queueIndex: 0,
            timestamp: 0,
            blockNumber: 0,
            txData: '0x',
          },
          {
            batchIndex: 0,
            batchRoot: getQueueLeafHash(0),
            batchSize: 1,
            prevTotalElements: 0,
            extraData: '0x',
          },
          {
            index: 0,
            siblings: [],
          }
        )
      ).to.equal(true)
    })

    it('should successfully verify against a valid sequencer transaction', async () => {
      const entrypoint = DECOMPRESSION_ADDRESS
      const gasLimit = MAX_GAS_LIMIT
      const data = '0x' + '12'.repeat(1234)
      const timestamp = (await getEthTime(ethers.provider)) - 10
      const blockNumber = (await ethers.provider.getBlockNumber()) - 1

      await appendSequencerBatch(
        OVM_CanonicalTransactionChain.connect(sequencer),
        {
          shouldStartAtElement: 0,
          totalElementsToAppend: 1,
          contexts: [
            {
              numSequencedTransactions: 1,
              numSubsequentQueueTransactions: 0,
              timestamp: timestamp,
              blockNumber: blockNumber,
            },
          ],
          transactions: [data],
        }
      )

      expect(
        await OVM_CanonicalTransactionChain.verifyTransaction(
          {
            timestamp,
            blockNumber,
            l1QueueOrigin: 0,
            l1TxOrigin: ZERO_ADDRESS,
            entrypoint,
            gasLimit,
            data,
          },
          {
            isSequenced: true,
            queueIndex: 0,
            timestamp,
            blockNumber,
            txData: data,
          },
          {
            batchIndex: 0,
            batchRoot: getSequencerLeafHash(timestamp, blockNumber, data),
            batchSize: 1,
            prevTotalElements: 0,
            extraData: '0x',
          },
          {
            index: 0,
            siblings: [],
          }
        )
      ).to.equal(true)
    })
  })

  describe('appendSequencerBatch', () => {
    beforeEach(() => {
      OVM_CanonicalTransactionChain = OVM_CanonicalTransactionChain.connect(
        sequencer
      )
    })

    it.skip(
      'should allow for a lower bound per-tx gas usage of <400 gas [GAS BENCHMARK]',
      async () => {
        const timestamp = (await getEthTime(ethers.provider)) - 100
        const blockNumber = (await getNextBlockNumber(ethers.provider)) + 100

        // do two batch appends for no reason
        await appendSequencerBatch(OVM_CanonicalTransactionChain, {
          shouldStartAtElement: 0,
          totalElementsToAppend: 1,
          contexts: [
            {
              numSequencedTransactions: 1,
              numSubsequentQueueTransactions: 0,
              timestamp,
              blockNumber,
            },
          ],
          transactions: ['0x1234'],
        })
        await appendSequencerBatch(OVM_CanonicalTransactionChain, {
          shouldStartAtElement: 1,
          totalElementsToAppend: 1,
          contexts: [
            {
              numSequencedTransactions: 1,
              numSubsequentQueueTransactions: 0,
              timestamp,
              blockNumber,
            },
          ],
          transactions: ['0x1234'],
        })

        console.log('\n~~~~ BEGINNGING TRASACTION IN QUESTION ~~~~')
        const transactions = []
        const numTxs = 200
        for (let i = 0; i < numTxs; i++) {
          transactions.push(
            '0x' + '1080111111111111111111111111111111111111111111'.repeat(20)
          )
        }
        const res = await appendSequencerBatch(OVM_CanonicalTransactionChain, {
          shouldStartAtElement: 2,
          totalElementsToAppend: numTxs,
          contexts: [
            {
              numSequencedTransactions: numTxs,
              numSubsequentQueueTransactions: 0,
              timestamp,
              blockNumber,
            },
          ],
          transactions,
        })
        const receipt = await res.wait()
        console.log('Benchmark complete. Gas used:', receipt.gasUsed)
      }
    ).timeout(100000000)

    it('should revert if expected start does not match current total batches', async () => {
      await expect(
        appendSequencerBatch(OVM_CanonicalTransactionChain, {
          transactions: ['0x1234'],
          contexts: [
            {
              numSequencedTransactions: 0,
              numSubsequentQueueTransactions: 0,
              timestamp: 0,
              blockNumber: 0,
            },
          ],
          shouldStartAtElement: 1234,
          totalElementsToAppend: 1,
        })
      ).to.be.revertedWith(
        'Actual batch start index does not match expected start index.'
      )
    })

    it('should revert if not all sequencer transactions are processed', async () => {
      const timestamp = await getEthTime(ethers.provider)
      const blockNumber = await getNextBlockNumber(ethers.provider) - 1

      await expect(
        appendSequencerBatch(OVM_CanonicalTransactionChain, {
          transactions: ['0x1234', '0x1234'],
          contexts: [
            {
              numSequencedTransactions: 0,
              numSubsequentQueueTransactions: 0,
              timestamp,
              blockNumber,
            },
          ],
          shouldStartAtElement: 0,
          totalElementsToAppend: 1,
        })
      ).to.be.revertedWith('Not all sequencer transactions were processed.')
    })

    it('should revert if not called by the sequencer', async () => {
      await expect(
        appendSequencerBatch(OVM_CanonicalTransactionChain.connect(signer), {
          transactions: ['0x1234'],
          contexts: [
            {
              numSequencedTransactions: 0,
              numSubsequentQueueTransactions: 0,
              timestamp: 0,
              blockNumber: 0,
            },
          ],
          shouldStartAtElement: 0,
          totalElementsToAppend: 1,
        })
      ).to.be.revertedWith('Function can only be called by the Sequencer.')
    })

    it('should revert if no contexts are provided', async () => {
      await expect(
        appendSequencerBatch(OVM_CanonicalTransactionChain, {
          transactions: ['0x1234'],
          contexts: [],
          shouldStartAtElement: 0,
          totalElementsToAppend: 1,
        })
      ).to.be.revertedWith('Must provide at least one batch context.')
    })

    it('should revert if total elements to append is zero', async () => {
      await expect(
        appendSequencerBatch(OVM_CanonicalTransactionChain, {
          transactions: ['0x1234'],
          contexts: [
            {
              numSequencedTransactions: 0,
              numSubsequentQueueTransactions: 0,
              timestamp: 0,
              blockNumber: 0,
            },
          ],
          shouldStartAtElement: 0,
          totalElementsToAppend: 0,
        })
      ).to.be.revertedWith('Must append at least one element.')
    })

    describe('Sad path cases', () => {
      const target = NON_ZERO_ADDRESS
      const gasLimit = 500_000
      const data = '0x' + '12'.repeat(1234)

      describe('when the sequencer attempts to add more queue transactions than exist', () => {
        it('reverts when there are zero transactions in the queue', async () => {
          const timestamp = await getEthTime(ethers.provider)
          const blockNumber = await getNextBlockNumber(ethers.provider) - 1

          await expect(
            appendSequencerBatch(OVM_CanonicalTransactionChain, {
              transactions: ['0x1234'],
              contexts: [
                {
                  numSequencedTransactions: 1,
                  numSubsequentQueueTransactions: 1,
                  timestamp,
                  blockNumber,
                },
              ],
              shouldStartAtElement: 0,
              totalElementsToAppend: 1,
            })
          ).to.be.revertedWith(
            'Not enough queued transactions to append.'
          )
        })

        it('reverts when there are insufficient (but nonzero) transactions in the queue', async () => {
          const timestamp = await getEthTime(ethers.provider)
          const blockNumber = await getNextBlockNumber(ethers.provider) - 1
          
          const numEnqueues = 7
          for (let i = 0; i < numEnqueues; i++) {
            await OVM_CanonicalTransactionChain.enqueue(target, gasLimit, data)
          }

          await expect(
            appendSequencerBatch(OVM_CanonicalTransactionChain, {
              transactions: ['0x1234'],
              contexts: [
                {
                  numSequencedTransactions: 1,
                  numSubsequentQueueTransactions: numEnqueues + 1,
                  timestamp,
                  blockNumber,
                },
              ],
              shouldStartAtElement: 0,
              totalElementsToAppend: numEnqueues + 1,
            })
          ).to.be.revertedWith(
            'Not enough queued transactions to append.'
          )
        })
      })

      describe('when the sequencer attempts to add transactions which are not monotonically increasing', () => {
        describe('when the sequencer transactions themselves have out-of-order times', () => {
          it('should revert when adding two out-of-order-timestamp sequencer elements', async () => {
            const timestamp = await getEthTime(ethers.provider)
            const blockNumber = await getNextBlockNumber(ethers.provider) - 1

            await expect(
              appendSequencerBatch(OVM_CanonicalTransactionChain, {
                transactions: ['0x1234', '0x5678'],
                contexts: [
                  {
                    numSequencedTransactions: 1,
                    numSubsequentQueueTransactions: 0,
                    timestamp: timestamp + 1,
                    blockNumber,
                  },
                  {
                    numSequencedTransactions: 1,
                    numSubsequentQueueTransactions: 0,
                    timestamp,
                    blockNumber,
                  },
                ],
                shouldStartAtElement: 0,
                totalElementsToAppend: 2,
              })
            ).to.be.revertedWith(
              'Context timestamp values must monotonically increase.'
            )
          })

          it('should revert when adding two out-of-order-blocknumber sequencer elements', async () => {
            const timestamp = await getEthTime(ethers.provider)
            const blockNumber = await getNextBlockNumber(ethers.provider) - 1
            
            await expect(
              appendSequencerBatch(OVM_CanonicalTransactionChain, {
                transactions: ['0x1234', '0x5678'],
                contexts: [
                  {
                    numSequencedTransactions: 1,
                    numSubsequentQueueTransactions: 0,
                    timestamp,
                    blockNumber: blockNumber + 1,
                  },
                  {
                    numSequencedTransactions: 1,
                    numSubsequentQueueTransactions: 0,
                    timestamp,
                    blockNumber,
                  },
                ],
                shouldStartAtElement: 0,
                totalElementsToAppend: 2,
              })
            ).to.be.revertedWith(
              'Context blockNumber values must monotonically increase.'
            )
          }) 
        })
        describe('when the elements are out-of-order with regards to pending queue elements', async () => {
          describe('adding a single sequencer transaction with a single pending queue element', () => {
            beforeEach(async () => {
              // enqueue a single element so that it is pending, but do not yet apply it
              await OVM_CanonicalTransactionChain.enqueue(target, gasLimit, data)
            })
            it('should revert if the first context timestamp is > the head queue element timestamp', async () => {
              const timestamp = await getEthTime(ethers.provider) + 100
      
              await expect(
                appendSequencerBatch(OVM_CanonicalTransactionChain, {
                  transactions: ['0x1234'],
                  contexts: [
                    {
                      numSequencedTransactions: 1,
                      numSubsequentQueueTransactions: 0,
                      timestamp: timestamp,
                      blockNumber: 0,
                    },
                  ],
                  shouldStartAtElement: 0,
                  totalElementsToAppend: 1,
                })
              ).to.be.revertedWith('Sequencer transaction timestamp exceeds that of next queue element.')
            })
      
            it('should revert if the context block number is > the head queue element block number', async () => {              
                const timestamp = (await getEthTime(ethers.provider)) - 100
                const blockNumber = (await getNextBlockNumber(ethers.provider)) + 100
      
                await expect(
                  appendSequencerBatch(OVM_CanonicalTransactionChain, {
                    transactions: ['0x1234'],
                    contexts: [
                      {
                        numSequencedTransactions: 1,
                        numSubsequentQueueTransactions: 0,
                        timestamp: timestamp,
                        blockNumber: blockNumber,
                      },
                    ],
                    shouldStartAtElement: 0,
                    totalElementsToAppend: 1,
                  })
                ).to.be.revertedWith('Sequencer transaction blockNumber exceeds that of next queue element.')
              })
            })  
          })

          describe('adding multiple sequencer transactions with multiple pending queue elements', () => {
            const numQueuedTransactions = 10
            let queueElements = []
            let validContexts = []
            beforeEach(async () => {
              for (let i = 0; i < numQueuedTransactions; i++) {
                await OVM_CanonicalTransactionChain.enqueue(target, gasLimit, data)
                queueElements[i] = await OVM_CanonicalTransactionChain.getQueueElement(i)
                // this is a valid context for this TX
                validContexts[i] = {
                  numSequencedTransactions: 1,
                  numSubsequentQueueTransactions: 1,
                  timestamp: queueElements[i].timestamp,
                  blockNumber: queueElements[i].blockNumber,
                }
              }
            })

            it('does not revert for valid context', async () => {
              await appendSequencerBatch(OVM_CanonicalTransactionChain, {
                  transactions: new Array(numQueuedTransactions).fill('0x1234'),
                  contexts: validContexts,
                  shouldStartAtElement: 0,
                  totalElementsToAppend: 2 * numQueuedTransactions,
                })
            })

            it('reverts if wrong timestamp in middle', async () => {
              let invalidTimestampContexts = [ ...validContexts ]
              // put a bigger timestamp early
              invalidTimestampContexts[6].timestamp = invalidTimestampContexts[8].timestamp

              await expect(
                appendSequencerBatch(OVM_CanonicalTransactionChain, {
                  transactions: new Array(numQueuedTransactions).fill('0x1234'),
                  contexts: invalidTimestampContexts,
                  shouldStartAtElement: 0,
                  totalElementsToAppend: 2 * numQueuedTransactions,
                })
              ).to.be.revertedWith('Sequencer transaction timestamp exceeds that of next queue element.')
            })

            it('reverts if wrong block number in the middle', async () => {
              let invalidBlockNumberContexts = [ ...validContexts ]
              // put a bigger block number early
              invalidBlockNumberContexts[6].blockNumber = invalidBlockNumberContexts[8].blockNumber

              await expect(
                appendSequencerBatch(OVM_CanonicalTransactionChain, {
                  transactions: new Array(numQueuedTransactions).fill('0x1234'),
                  contexts: invalidBlockNumberContexts,
                  shouldStartAtElement: 0,
                  totalElementsToAppend: 2 * numQueuedTransactions,
                })
              ).to.be.revertedWith('Sequencer transaction blockNumber exceeds that of next queue element.')
            })
          })
        })

      describe('when the sequencer attempts to add transactions with out-of-bounds times', async () => {
        describe('when trying to add elements from the future', () => {
          it('reverts on initial timestamp in the future', async () => {
            const timestamp = await getEthTime(ethers.provider) + 100_000_000
            const blockNumber = await getNextBlockNumber(ethers.provider) - 1

            await expect(
              appendSequencerBatch(OVM_CanonicalTransactionChain, {
                transactions: ['0x1234'],
                contexts: [
                  {
                    numSequencedTransactions: 1,
                    numSubsequentQueueTransactions: 0,
                    timestamp,
                    blockNumber,
                  },
                ],
                shouldStartAtElement: 0,
                totalElementsToAppend: 1,
              })
            ).to.be.revertedWith('Context timestamp is from the future.')
          })

          it('reverts on non-initial timestamp in the future', async () => {
            const timestamp = await getEthTime(ethers.provider)
            const blockNumber = await getNextBlockNumber(ethers.provider) - 1

            await expect(
              appendSequencerBatch(OVM_CanonicalTransactionChain, {
                transactions: ['0x1234', '0x1234'],
                contexts: [
                  {
                    numSequencedTransactions: 1,
                    numSubsequentQueueTransactions: 0,
                    timestamp,
                    blockNumber,
                  },
                  {
                    numSequencedTransactions: 1,
                    numSubsequentQueueTransactions: 0,
                    timestamp: timestamp + 100_000_000,
                    blockNumber,
                  },
                ],
                shouldStartAtElement: 0,
                totalElementsToAppend: 2,
              })
            ).to.be.revertedWith('Context timestamp is from the future.')
          })

          it('reverts on initial blocknumber in the future', async () => {
            const timestamp = await getEthTime(ethers.provider)
            const blockNumber = await getNextBlockNumber(ethers.provider) + 1

            await expect(
              appendSequencerBatch(OVM_CanonicalTransactionChain, {
                transactions: ['0x1234'],
                contexts: [
                  {
                    numSequencedTransactions: 1,
                    numSubsequentQueueTransactions: 0,
                    timestamp,
                    blockNumber,
                  },
                ],
                shouldStartAtElement: 0,
                totalElementsToAppend: 1,
              })
            ).to.be.revertedWith('Context block number is from the future.')
          })
        })
      })

      describe('when trying to add elements which are older than the force inclusion period', async () => {
        it('reverts for a timestamp older than the f.i.p. ago', async () => {
          const timestamp = await getEthTime(ethers.provider)
          await increaseEthTime(ethers.provider, FORCE_INCLUSION_PERIOD_SECONDS + 1)
          const blockNumber = await getNextBlockNumber(ethers.provider) - 1

          await expect(
            appendSequencerBatch(OVM_CanonicalTransactionChain, {
              transactions: ['0x1234'],
              contexts: [
                {
                  numSequencedTransactions: 1,
                  numSubsequentQueueTransactions: 0,
                  timestamp,
                  blockNumber,
                },
              ],
              shouldStartAtElement: 0,
              totalElementsToAppend: 1,
            })
          ).to.be.revertedWith('Context timestamp too far in the past.')
        })

        it('reverts for a blockNumber older than the f.i.p. ago', async () => {
          const timestamp = await getEthTime(ethers.provider)
          
          for (let i = 0; i < FORCE_INCLUSION_PERIOD_BLOCKS + 1; i++) {
            await ethers.provider.send('evm_mine', [])
          }

          await expect(
            appendSequencerBatch(OVM_CanonicalTransactionChain, {
              transactions: ['0x1234'],
              contexts: [
                {
                  numSequencedTransactions: 1,
                  numSubsequentQueueTransactions: 0,
                  timestamp,
                  blockNumber: 0,
                },
              ],
              shouldStartAtElement: 0,
              totalElementsToAppend: 1,
            })
          ).to.be.revertedWith('Context timestamp too far in the past.')
        })
      })

      describe('when trying to add elements which are older than already existing CTC elements', () => {
        let timestamp
        let blockNumber
        describe('when the most recent CTC element is a sequencer transaction', () => {
          beforeEach(async () => {
            timestamp = await getEthTime(ethers.provider)
            blockNumber = await getNextBlockNumber(ethers.provider) - 1
            await appendSequencerBatch(OVM_CanonicalTransactionChain, {
              transactions: ['0x1234'],
              contexts: [
                {
                  numSequencedTransactions: 1,
                  numSubsequentQueueTransactions: 0,
                  timestamp,
                  blockNumber,
                },
              ],
              shouldStartAtElement: 0,
              totalElementsToAppend: 1,
            })
          })
          
          it('reverts if timestamp is older than previous one', async () => {
            await expect(
              appendSequencerBatch(OVM_CanonicalTransactionChain, {
                transactions: ['0x1234'],
                contexts: [
                  {
                    numSequencedTransactions: 1,
                    numSubsequentQueueTransactions: 0,
                    timestamp: timestamp - 1,
                    blockNumber,
                  },
                ],
                shouldStartAtElement: 1,
                totalElementsToAppend: 1,
              })
            ).to.be.revertedWith(
              'Context timestamp is lower than last submitted.'
            )
          })

          it('reverts if block number is older than previous one', async () => {
            await expect(
              appendSequencerBatch(OVM_CanonicalTransactionChain, {
                transactions: ['0x1234'],
                contexts: [
                  {
                    numSequencedTransactions: 1,
                    numSubsequentQueueTransactions: 0,
                    timestamp,
                    blockNumber: blockNumber - 1,
                  },
                ],
                shouldStartAtElement: 1,
                totalElementsToAppend: 1,
              })
            ).to.be.revertedWith(
              'Context block number is lower than last submitted.'
            )
          })
        })
        
        describe('when the previous transaction is a queue transaction', () => {
          beforeEach(async () => {
            // enqueue
            timestamp = await getEthTime(ethers.provider)
            blockNumber = await getNextBlockNumber(ethers.provider)
            await OVM_CanonicalTransactionChain.enqueue(target, gasLimit, data)
            await appendSequencerBatch(OVM_CanonicalTransactionChain, {
              transactions: ['0x1234'],
              contexts: [
                {
                  numSequencedTransactions: 1,
                  numSubsequentQueueTransactions: 1, // final element will be CTC
                  timestamp,
                  blockNumber,
                },
              ],
              shouldStartAtElement: 0,
              totalElementsToAppend: 2,
            })
          })
          
          it('reverts if timestamp is older than previous one', async () => {
            await expect(
              appendSequencerBatch(OVM_CanonicalTransactionChain, {
                transactions: ['0x1234'],
                contexts: [
                  {
                    numSequencedTransactions: 1,
                    numSubsequentQueueTransactions: 0,
                    timestamp: timestamp - 1,
                    blockNumber,
                  },
                ],
                shouldStartAtElement: 2,
                totalElementsToAppend: 1,
              })
            ).to.be.revertedWith(
              'Context timestamp is lower than last submitted.'
            )
          })

          it('reverts if block number is older than previous one', async () => {
            await expect(
              appendSequencerBatch(OVM_CanonicalTransactionChain, {
                transactions: ['0x1234'],
                contexts: [
                  {
                    numSequencedTransactions: 1,
                    numSubsequentQueueTransactions: 0,
                    timestamp,
                    blockNumber: blockNumber - 1,
                  },
                ],
                shouldStartAtElement: 2,
                totalElementsToAppend: 1,
              })
            ).to.be.revertedWith(
              'Context block number is lower than last submitted.'
            )
          })
        })
      })

      it('should revert if a queue element has expired and needs to be included', async () => {
        // enqueue a tx
        await OVM_CanonicalTransactionChain.enqueue(target, gasLimit, data)
        // increase time past force inclusion period
        await increaseEthTime(
          ethers.provider,
          FORCE_INCLUSION_PERIOD_SECONDS * 2
        )

        const validTimestamp = await getBlockTime(
          ethers.provider
        ) + 100

        await expect(
          appendSequencerBatch(OVM_CanonicalTransactionChain, {
            transactions: ['0x1234'],
            contexts: [
              {
                numSequencedTransactions: 1,
                numSubsequentQueueTransactions: 0,
                timestamp: validTimestamp,
                blockNumber: 0,
              },
            ],
            shouldStartAtElement: 0,
            totalElementsToAppend: 1,
          })
        ).to.be.revertedWith(
          'Previously enqueued batches have expired and must be appended before a new sequencer batch.'
        )
      })
    })

    for (const size of ELEMENT_TEST_SIZES) {
      const target = NON_ZERO_ADDRESS
      const gasLimit = 500_000
      const data = '0x' + '12'.repeat(1234)

      describe(`Happy path: when appending ${size} sequencer transactions`, () => {
        describe('when not inserting queue elements in between', () => {
          describe('when using a single batch context', () => {
            let contexts: any[]
            let transactions: any[]
            beforeEach(async () => {
              const timestamp = (await getEthTime(ethers.provider)) - 100
              const blockNumber =
                (await getNextBlockNumber(ethers.provider)) - 10

              contexts = [
                {
                  numSequencedTransactions: size,
                  numSubsequentQueueTransactions: 0,
                  timestamp: timestamp,
                  blockNumber: blockNumber,
                },
              ]

              transactions = [...Array(size)].map((el, idx) => {
                return '0x' + '12' + '34'.repeat(idx)
              })
            })

            it('should append the given number of transactions', async () => {
              await expect(
                appendSequencerBatch(OVM_CanonicalTransactionChain, {
                  transactions,
                  contexts,
                  shouldStartAtElement: 0,
                  totalElementsToAppend: size,
                })
              )
                .to.emit(
                  OVM_CanonicalTransactionChain,
                  'SequencerBatchAppended'
                )
                .withArgs(0, 0, size)
            })
          })
        })

        describe('when inserting queue elements in between', () => {
          beforeEach(async () => {
            for (let i = 0; i < size; i++) {
              await OVM_CanonicalTransactionChain.enqueue(
                target,
                gasLimit,
                data
              )
            }
          })

          describe('between every other sequencer transaction', () => {
            let contexts: any[]
            let transactions: any[]
            beforeEach(async () => {
              const timestamp = (await getEthTime(ethers.provider)) - 100
              const blockNumber =
                (await getNextBlockNumber(ethers.provider)) - 50

              contexts = [...Array(size)].map(() => {
                return {
                  numSequencedTransactions: 1,
                  numSubsequentQueueTransactions: 1,
                  timestamp: timestamp,
                  blockNumber: Math.max(blockNumber, 0),
                }
              })

              transactions = [...Array(size)].map((el, idx) => {
                return '0x' + '12' + '34'.repeat(idx)
              })
            })

            it('should append the batch', async () => {
              await expect(
                appendSequencerBatch(OVM_CanonicalTransactionChain, {
                  transactions,
                  contexts,
                  shouldStartAtElement: 0,
                  totalElementsToAppend: size * 2,
                })
              )
                .to.emit(
                  OVM_CanonicalTransactionChain,
                  'SequencerBatchAppended'
                )
                .withArgs(0, size, size * 2)
            })
          })

          const spacing = Math.max(Math.floor(size / 4), 1)
          describe(`between every ${spacing} sequencer transaction`, () => {
            let contexts: any[]
            let transactions: any[]
            beforeEach(async () => {
              const timestamp = (await getEthTime(ethers.provider)) - 100
              const blockNumber =
                (await getNextBlockNumber(ethers.provider)) - 50

              contexts = [...Array(spacing)].map(() => {
                return {
                  numSequencedTransactions: size / spacing,
                  numSubsequentQueueTransactions: 1,
                  timestamp: timestamp,
                  blockNumber: Math.max(blockNumber, 0),
                }
              })

              transactions = [...Array(size)].map((el, idx) => {
                return '0x' + '12' + '34'.repeat(idx)
              })
            })

            it('should append the batch', async () => {
              await expect(
                appendSequencerBatch(OVM_CanonicalTransactionChain, {
                  transactions,
                  contexts,
                  shouldStartAtElement: 0,
                  totalElementsToAppend: size + spacing,
                })
              )
                .to.emit(
                  OVM_CanonicalTransactionChain,
                  'SequencerBatchAppended'
                )
                .withArgs(0, spacing, size + spacing)
            })
          })
        })
      })
    }
  })

  describe('getTotalElements', () => {
    it('should return zero when no elements exist', async () => {
      expect(await OVM_CanonicalTransactionChain.getTotalElements()).to.equal(0)
    })

    for (const size of ELEMENT_TEST_SIZES) {
      describe(`when the sequencer inserts a batch of ${size} elements`, () => {
        beforeEach(async () => {
          const timestamp = (await getEthTime(ethers.provider)) - 100
          const blockNumber = (await getNextBlockNumber(ethers.provider)) - 10

          const contexts = [
            {
              numSequencedTransactions: size,
              numSubsequentQueueTransactions: 0,
              timestamp: timestamp,
              blockNumber: Math.max(blockNumber, 0),
            },
          ]

          const transactions = [...Array(size)].map((el, idx) => {
            return '0x' + '12' + '34'.repeat(idx)
          })

          const res = await appendSequencerBatch(
            OVM_CanonicalTransactionChain.connect(sequencer),
            {
              transactions,
              contexts,
              shouldStartAtElement: 0,
              totalElementsToAppend: size,
            }
          )
          await res.wait()
        })

        it(`should return ${size}`, async () => {
          expect(
            await OVM_CanonicalTransactionChain.getTotalElements()
          ).to.equal(size)
        })
      })
    }
  })
})
