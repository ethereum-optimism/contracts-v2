/* Imports: External */
import { DeployFunction } from 'hardhat-deploy/dist/types'

/* Imports: Internal */
import { deploy } from '../src/hardhat-deploy-ethers'

const deployFn: DeployFunction = async (hre) => {
  const cfg = {
    hre,
    name: 'OVM_StateManagerFactory',
    args: [],
    withAddressManager: false,
  }
  await deploy(cfg)
}

deployFn.tags = ['OVM_StateManagerFactory']

export default deployFn
