/* Imports: External */
import { Contract } from 'ethers'
import { Provider } from '@ethersproject/abstract-provider'
import { Signer } from '@ethersproject/abstract-signer'
import { HardhatRuntimeEnvironment } from 'hardhat/types'

export const deployAndRegister = async ({
  hre,
  name,
  args,
  contract,
}: {
  hre: HardhatRuntimeEnvironment
  name: string
  args: any[]
  contract?: string
}) => {
  const { deploy } = hre.deployments

  // TODO: Cache these 2 across calls?
  const { deployer } = await hre.getNamedAccounts()
  const Lib_AddressManager = await getDeployedContract(
    hre,
    'Lib_AddressManager',
    {
      signerOrProvider: deployer,
    }
  )

  const result = await deploy(name, {
    contract,
    from: deployer,
    args,
    log: true,
  })

  if (result.newlyDeployed) {
    const tx = await Lib_AddressManager.setAddress(name, result.address)
    await tx.wait()

    const remoteAddress = await Lib_AddressManager.getAddress(name)
    if (remoteAddress !== result.address) {
      throw new Error(
        `\n**FATAL ERROR. THIS SHOULD NEVER HAPPEN. CHECK YOUR DEPLOYMENT.**:\n` +
          `Call to Lib_AddressManager.setAddress(${name}) was unsuccessful.\n` +
          `Attempted to set address to: ${result.address}\n` +
          `Actual address was set to: ${remoteAddress}\n` +
          `This could indicate a compromised deployment.`
      )
    }
  }
}

export const getDeployedContract = async (
  hre: HardhatRuntimeEnvironment,
  name: string,
  options: {
    iface?: string
    signerOrProvider?: Signer | Provider | string
  } = {}
): Promise<Contract> => {
  const deployed = await hre.deployments.get(name)

  await hre.ethers.provider.waitForTransaction(deployed.receipt.transactionHash)

  // Get the correct interface.
  let iface = new hre.ethers.utils.Interface(deployed.abi)
  if (options.iface) {
    const factory = await hre.ethers.getContractFactory(options.iface)
    iface = factory.interface
  }

  let signerOrProvider: Signer | Provider = hre.ethers.provider
  if (options.signerOrProvider) {
    if (typeof options.signerOrProvider === 'string') {
      signerOrProvider = hre.ethers.provider.getSigner(options.signerOrProvider)
    } else {
      signerOrProvider = options.signerOrProvider
    }
  }

  // Temporarily override Object.defineProperty to bypass ether's object protection.
  const def = Object.defineProperty
  Object.defineProperty = (obj, propName, prop) => {
    prop.writable = true
    return def(obj, propName, prop)
  }

  const contract = new Contract(deployed.address, iface, signerOrProvider)

  // Now reset Object.defineProperty
  Object.defineProperty = def

  // Override each function call to also `.wait()` so as to simplify the deploy scripts' syntax.
  for (const fnName of Object.keys(contract.functions)) {
    const fn = contract[fnName].bind(contract)
    ;(contract as any)[fnName] = async (...args: any) => {
      const result = await fn(...args)
      if (typeof result === 'object' && typeof result.wait === 'function') {
        await result.wait()
      }
      return result
    }
  }

  return contract
}
