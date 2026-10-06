package fictional;
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.PostMapping;
@FeignClient(name = "proposal", url = "${proposal.url}")
public interface ProposalClient {
    @PostMapping("/proposal") String create();
}
