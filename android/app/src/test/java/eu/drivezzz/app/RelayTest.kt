package eu.drivezzz.app

import eu.drivezzz.app.core.Base58
import eu.drivezzz.app.core.MetaMaskConnect
import eu.drivezzz.app.core.Secure
import eu.drivezzz.app.core.WalletConnectClient
import eu.drivezzz.app.core.WalletFailure
import eu.drivezzz.app.core.Wallets
import kotlinx.coroutines.DelicateCoroutinesApi
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.newSingleThreadContext
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.security.MessageDigest
import java.util.Base64
import kotlin.concurrent.thread

// The real relays, with the wallet side played by the real libraries on the server: server/test/reference/wc-wallet.mjs (WalletConnect's own)
// and mm-wallet.mjs (MetaMask's own). Off by default. Needs the shared ssh connection of CLAUDE.md and those scripts in place: docs/android.md.
//   DRIVEZZZ_RELAY=1 ./gradlew :app:testDebugUnitTest --tests '*RelayTest*' --rerun
@OptIn(ExperimentalCoroutinesApi::class, DelicateCoroutinesApi::class)
class RelayTest {
    private val main = newSingleThreadContext("main")
    private val project = "31ae35073ce5a54aa9051157dfb9c1a3"

    @Before fun setup() {
        assumeTrue(System.getenv("DRIVEZZZ_RELAY") == "1")
        Dispatchers.setMain(main)
        Secure.useMemory()
    }

    private val output = StringBuffer()

    private fun onServer(command: String) {
        thread(isDaemon = true) {
            val p = ProcessBuilder("ssh", "-S", File(System.getProperty("user.home"), ".ssh/drivezzz-server.sock").path, "root@your-server", command)
                .redirectErrorStream(true).start()
            p.inputStream.bufferedReader().forEachLine {
                println("  wallet: $it")
                output.append(it).append('\n')
            }
        }
    }

    private fun walletConnectWallet(link: String, how: String) =
        onServer("cd /home/dzbuild/wc && test -f sim-key.json || /opt/drivezzz/node/bin/node -e 'console.log(JSON.stringify([...require(\"crypto\").randomBytes(64)]))' > sim-key.json; timeout 100 /opt/drivezzz/node/bin/node wc-wallet.mjs $project '$link' $how")

    private fun metaMaskWallet(link: String, what: String) =
        onServer("cd /home/dzbuild/mm && timeout 100 /opt/drivezzz/node/bin/node mm-wallet.mjs '$link' $what")

    private suspend fun <T> onMain(block: suspend () -> T): T = withTimeout(90_000) { withContext(main) { block() } }

    private fun walletConnectPays(answers: String) = runBlocking {
        val client = WalletConnectClient()
        val mainnet = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
        val devnet = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"
        val session = onMain { client.connect(project, devnet, listOf(mainnet)) { link -> walletConnectWallet(link, "pay sim-key.json $answers") } }
        assertTrue(session.address.length in 32..44)
        assertEquals(devnet, session.chain)

        // A transaction as Solana has them: how many signatures, room for them, then what's signed.
        val message = ByteArray(120) { (it * 7).toByte() }
        val transaction = byteArrayOf(1) + ByteArray(64) + message
        val answer = onMain {
            client.request(session, project, "solana_signTransaction", mapOf("transaction" to Base64.getEncoder().encodeToString(transaction))) {}
        }
        val signed = Wallets.wholeOrSignature(answer, transaction)
        assertEquals(transaction.size, signed.size)
        assertArrayEquals(message, signed.copyOfRange(65, signed.size))
        val verify = Ed25519Signer()
        verify.init(false, Ed25519PublicKeyParameters(Base58.decode(session.address)!!, 0))
        verify.update(message, 0, message.size)
        assertTrue("the signature is the wallet's, over this message", verify.verifySignature(signed.copyOfRange(1, 65)))
    }

    @Test fun walletConnectSignatureOnly() = walletConnectPays("signature")

    @Test fun walletConnectWholeTransaction() = walletConnectPays("transaction")

    @Test fun walletConnectAccountsOnly() = runBlocking {
        val client = WalletConnectClient()
        val session = onMain { client.connect(project, "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp") { link -> walletConnectWallet(link, "all") } }
        assertEquals("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", session.address)
    }

    @Test fun metaMaskConnectsAndSigns() = runBlocking {
        val client = MetaMaskConnect()
        val session = onMain { client.connect { link -> metaMaskWallet(link, "approve") } }
        assertEquals("G3kHqPretendWalletAddress1111111111111111111", session.address)
        assertTrue(output.toString().contains("link passes their checks"))

        val transaction = ByteArray(200) { (it * 3).toByte() }
        val signed = onMain { client.signTransaction(transaction, session) {} }
        // The scripted wallet answers with a hash of what it was given, up front, so this side can see it read the same bytes.
        val hash = MessageDigest.getInstance("SHA-256").digest(transaction)
        assertArrayEquals(hash + transaction, signed)
    }

    @Test fun metaMaskDecline() = runBlocking {
        val client = MetaMaskConnect()
        val failure = runCatching { onMain { client.connect { link -> metaMaskWallet(link, "decline") } } }.exceptionOrNull()
        assertTrue("got $failure", failure is WalletFailure.Declined)
    }

    @Test fun metaMaskNoSolanaAccount() = runBlocking {
        val client = MetaMaskConnect()
        val failure = runCatching { onMain { client.connect { link -> metaMaskWallet(link, "empty") } } }.exceptionOrNull()
        assertTrue("got $failure", failure is WalletFailure.NoSolanaAccount)
    }
}
