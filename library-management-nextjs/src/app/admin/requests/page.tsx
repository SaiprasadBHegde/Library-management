import { fetchRequests } from "@/lib/actions";
import { IPagedResponse, IPageRequest } from "@/lib/core/pagination";
import PaginationControl from "@/components/ui/paginationControl";
import Search from "@/components/ui/search";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { CheckCircle, XCircle } from "lucide-react";
import { ITransaction } from "@/lib/database/zod/transaction.schema";
import { BookRepository } from "@/lib/repositories/book.repository";
import { drizzleAdapter } from "@/lib/database/drizzle-orm/drizzleMysqlAdapter";
import { MemberRepository } from "@/lib/repositories/member.repository";

export default async function RequestManagementPage({
  searchParams,
}: {
  searchParams?: {
    query?: string;
    page?: string;
  };
}) {
  let currentPage = Number(searchParams?.page) || 1;
  const query = searchParams?.query || "";
  const limit = 5;

  const listParameters: IPageRequest = {
    search: query,
    offset: (currentPage - 1) * limit,
    limit: limit,
  };

  const paginatedRequest = await fetchRequests(listParameters);
  const paginationOptions = paginatedRequest?.pagination;
  const requests = paginatedRequest?.items;
  const bookRepo = new BookRepository(drizzleAdapter);
  const memberRepo = new MemberRepository(drizzleAdapter);

  // Fetch member and book details for each request
  const enrichedRequests = await Promise.all(
    requests!.map(async (request) => {
      const member = await memberRepo.getById(Number(request.memberId));
      const book = await bookRepo.getById(Number(request.bookId));
      return {
        ...request,
        memberName: member?.name || "Unknown Member",
        memberEmail: member?.email || "Unknown Email",
        bookTitle: book?.title || "Unknown Book",
      };
    })
  );

  async function handleApprove() {
    // Implement approve logic here
    //console.log(`Approve request ${requestId}`);
  }

  async function handleReject() {
    // Implement reject logic here
    // console.log(`Reject request ${requestId}`);
  }

  return (
    <>
      <div className="w-full flex justify-between items-center mb-8">
        <h1 className="text-3xl font-serif lg:text-4xl">Request Management</h1>
      </div>
      <div className="mb-6"></div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Member</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Book Title</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {enrichedRequests.map((request) => (
              <TableRow key={request.id}>
                <TableCell>{request.memberName}</TableCell>
                <TableCell>{request.memberEmail}</TableCell>
                <TableCell>{request.bookTitle}</TableCell>
                <TableCell>
                  <div className="flex space-x-2">
                    <Button className="bg-green-500 hover:bg-green-600 text-white">
                      <CheckCircle className="mr-2 h-4 w-4" />
                      Approve
                    </Button>
                    <Button className="bg-red-500 hover:bg-red-600 text-white">
                      <XCircle className="mr-2 h-4 w-4" />
                      Reject
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {requests?.length === 0 && (
        <p className="text-center mt-4">No requests found</p>
      )}
      <div className="flex justify-center mt-8">
        <PaginationControl
          currentPage={currentPage}
          options={paginationOptions!}
        />
      </div>
    </>
  );
}
