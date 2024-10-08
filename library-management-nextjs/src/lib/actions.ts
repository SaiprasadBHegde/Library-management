"use server";
import { ZodError } from "zod";
import {
  drizzleAdapter,
  books,
  members,
} from "./database/drizzle-orm/drizzleMysqlAdapter";
import {
  IBook,
  IMemberBase,
  ITransaction,
  ITransactionBase,
  IBookBase,
  IProfessorBase,
  IProfessor,
} from "./definitions";
import { IMember, MemberBaseSchema } from "./database/zod/member.schema";
import { hashPassword } from "./hashing/passwordHashing";
import { eq } from "drizzle-orm";
import { MemberRepository } from "./repositories/member.repository";
import { BookRepository } from "./repositories/book.repository";
import { auth, signIn } from "@/auth";
import { AuthError } from "next-auth";
import { IPagedResponse, IPageRequest } from "./core/pagination";
import { redirect } from "next/navigation";
import {
  BookSchema,
  BookSchemaBase,
  BookUpdateSchema,
} from "./database/zod/book.schema";
import { error } from "console";
import { revalidatePath } from "next/cache";
import { TransactionRepository } from "./repositories/transaction.repository";
import { MySql2Database } from "drizzle-orm/mysql2";
import { use } from "react";
import { ProfessorRepository } from "./repositories/professor.repository";
import { ProfessorBaseSchema } from "./database/zod/professor.schema";
import { AppEnvs } from "./core/read-env";
import Razorpay from "razorpay";

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!, // Store these in your .env.local
  key_secret: process.env.RAZORPAY_KEY_SECRET!,
});

interface Invitee {
  email: string;
  name: string;
}

interface Event {
  uri: string;
  name: string;
  start_time: string;
  end_time: string;
  invitees: Invitee[]; // Array of invitees
}

const memberRepo = new MemberRepository(drizzleAdapter);
const bookRepo = new BookRepository(drizzleAdapter);
const connection = await drizzleAdapter.getConnection();
const transactionRepo = new TransactionRepository(drizzleAdapter);
const professorRepo = new ProfessorRepository(drizzleAdapter);
export async function fetchAllBooks() {
  const dbConnection = await drizzleAdapter.getConnection();
  const booksArray = dbConnection.select().from(books);
  return booksArray;
}

export async function authenticate(
  prevState: string | undefined,
  formData: FormData
) {
  try {
    const result = await signIn("credentials", {
      redirect: false,
      email: formData.get("email"),
      password: formData.get("password"),
    });
    const session = await auth();
    if (result) {
      if (session?.user.role === "admin") redirect("/admin/books");
      redirect("/user/books");
    }
  } catch (error) {
    if (error instanceof AuthError) {
      switch (error.type) {
        case "CredentialsSignin":
          return "Invalid credentials.";
        default:
          return "Something went wrong.";
      }
    }
    throw error;
  }
}

export async function createOrder(memberId: number, amount: number) {
  const options = {
    amount: amount * 100, // Convert to paise
    currency: "INR",
    receipt: `order_rcptid_${memberId}`,
  };

  try {
    const order = await razorpay.orders.create(options);
    return order;
  } catch (error) {
    console.error("Error creating Razorpay order:", error);
    throw new Error("Failed to create Razorpay order");
  }
}

export async function getOrganizationUri() {
  try {
    const response = await fetch("https://api.calendly.com/users/me", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${AppEnvs.NEXT_PUBLIC_CALENDLY_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`Error fetching user info: ${response.statusText}`);
    }

    const data = await response.json();
    return data.resource.current_organization;
  } catch (error) {
    console.error("Error fetching user URI", error);
    throw error;
  }
}

export async function getUserUri() {
  try {
    const response = await fetch("https://api.calendly.com/users/me", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${AppEnvs.NEXT_PUBLIC_CALENDLY_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`Error fetching user info: ${response.statusText}`);
    }

    const data = await response.json();
    return data.resource.uri;
  } catch (error) {
    console.error("Error fetching user URI", error);
    throw error;
  }
}
export async function getScheduledEventsWithDetails(
  organization?: "organization"
) {
  const userUri = await getUserUri();
  const organizationUri = await getOrganizationUri();
  const session = await auth();
  const userEmail = session?.user.email;
  let fetchUrl;
  if (organization) {
    fetchUrl = `https://api.calendly.com/scheduled_events?organization=${encodeURIComponent(
      organizationUri
    )}`;
  } else {
    fetchUrl = `https://api.calendly.com/scheduled_events?organization=${encodeURIComponent(
      organizationUri
    )}&&invitee_email=${userEmail}`;
  }

  try {
    const response = await fetch(fetchUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${AppEnvs.NEXT_PUBLIC_CALENDLY_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.log("Error fetching scheduled events:", errorText);
      throw new Error(`Error fetching Calendly events: ${response.statusText}`);
    }

    const data = await response.json();
    const events = data.collection;

    // Get the current date and time in UTC
    const now = new Date();

    // Filter out past events (those that have already ended)
    const filteredEvents = events.filter((event: any) => {
      const eventStartTime = new Date(event.start_time);
      return eventStartTime >= now; // Only keep events starting now or in the future
    });

    const eventsWithDetails = await Promise.all(
      filteredEvents.map(async (event: any) => {
        // Get Google Meet link (if available)
        const meetLink = event.location?.join_url || "No Meet link";

        // Extract event UUID from the event URI
        const eventUUID = event.uri.split("/").pop();

        // Fetch invitee details for each event
        const invitees = await getInviteeDetails(eventUUID);

        // Fetch organizer details from event memberships
        const organizers = event.event_memberships.map((membership: any) => ({
          name: membership.user_name,
          email: membership.user_email,
        }));

        // Extract relevant fields from invitees
        const inviteeDetails = invitees.map((invitee: any) => ({
          name: invitee.name,
          email: invitee.email,
          cancel_url: invitee.cancel_url,
          reschedule_url: invitee.reschedule_url,
          status: invitee.status, // Invitee status
        }));

        return {
          event: event.name,
          start_time: event.start_time,
          end_time: event.end_time,
          meetLink: meetLink,
          status: event.status, // Event status
          organizers, // Organizers info
          invitees: inviteeDetails, // Invitee info with cancellation and reschedule URLs
          uuid: eventUUID,
        };
      })
    );

    return eventsWithDetails;
  } catch (error) {
    console.error("Error fetching scheduled events and details", error);
    throw error;
  }
}

// Helper function to get invitee details
export async function getInviteeDetails(event_uuid: string) {
  try {
    const response = await fetch(
      `https://api.calendly.com/scheduled_events/${event_uuid}/invitees`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${AppEnvs.NEXT_PUBLIC_CALENDLY_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.log("Error fetching invitees:", errorText);
      throw new Error(`Error fetching invitees: ${response.statusText}`);
    }

    const data = await response.json();
    return data.collection; // List of invitees
  } catch (error) {
    console.error("Error fetching invitee details", error);
    throw error;
  }
}

// Function to cancel a scheduled event (meeting) via Calendly API
export async function cancelScheduledEvent(
  eventUUID: string,
  cancelReason: string
) {
  try {
    const response = await fetch(
      `https://api.calendly.com/scheduled_events/${eventUUID}/cancellation`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${AppEnvs.NEXT_PUBLIC_CALENDLY_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          reason: cancelReason || "No reason provided",
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Error canceling the event:", errorText);
      throw new Error(`Error canceling event: ${response.statusText}`);
    }

    return response.json();
  } catch (error) {
    console.error("Error canceling event", error);
    throw error;
  }
}

export async function inviteUserToCalendlyAndCreateProfessor(
  formData: IProfessorBase
) {
  try {
    // Step 1: Get the Organization URI
    const organizationUri = await getOrganizationUri();

    // Step 2: Send Invite to Calendly API
    const inviteResponse = await fetch(`${organizationUri}/invitations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AppEnvs.NEXT_PUBLIC_CALENDLY_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: formData.email,
      }),
    });

    if (!inviteResponse.ok) {
      const errorDetails = await inviteResponse.text();
      throw new Error(
        `Error sending invite: ${inviteResponse.status} - ${inviteResponse.statusText}: ${errorDetails}`
      );
    }

    // Step 3: Create Professor Entry
    const professorRepo = new ProfessorRepository(drizzleAdapter);
    const createdProfessor = await professorRepo.create(formData);

    return createdProfessor;
  } catch (error) {
    console.error("Error inviting user and creating professor:", error);
    throw error;
  } finally {
    revalidatePath("/admin/professors");
    redirect("/admin/professors");
  }
}

export async function checkInvitationAndUpdateCalendlyLink(email: string) {
  try {
    // Step 1: Get the organization URI
    const organizationUri = await getOrganizationUri();
    const organizationId = organizationUri.split("/").pop(); // Extracting the UUID from the URI

    // Step 2: Fetch invitations filtered by email
    const invitationsResponse = await fetch(
      `https://api.calendly.com/organizations/${organizationId}/invitations?email=${encodeURIComponent(
        email
      )}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${AppEnvs.NEXT_PUBLIC_CALENDLY_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!invitationsResponse.ok) {
      throw new Error(
        `Error fetching invitations: ${invitationsResponse.statusText}`
      );
    }

    const invitationsData = await invitationsResponse.json();
    const invitation = invitationsData.collection[0]; // Assuming we're interested in the first invitation

    // Step 3: Check if the invitation status is accepted
    if (invitation && invitation.status === "accepted") {
      // Step 4: Fetch user details using the user URI from the invitation
      const userResponse = await fetch(invitation.user, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${AppEnvs.NEXT_PUBLIC_CALENDLY_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
      });

      if (!userResponse.ok) {
        throw new Error(`Error fetching user: ${userResponse.statusText}`);
      }

      const userData = await userResponse.json();
      const calendlyLink = userData.resource.scheduling_url; // Extracting the Calendly link

      // Step 5: Fetch the professor from your database by email
      const professor = await professorRepo.getByEmail(email);

      if (professor) {
        // Step 6: Update the professor with the Calendly link
        await professorRepo.update(professor.id, {
          ...professor,
          calendlyLink: calendlyLink,
        });
        return {
          success: true,
          message: "Calendly link updated successfully.",
        };
      } else {
        throw new Error("Professor not found in the database.");
      }
    } else {
      return {
        success: false,
        message: "Invitation not accepted or not found.",
      };
    }
  } catch (error) {
    console.error("Error in checkInvitationAndUpdateCalendlyLink:", error);
    throw error;
  } finally {
    revalidatePath("/admin/professors");
  }
}

export async function fetchMembershipUuid(email: string) {
  try {
    console.log("email while deleting", email);
    const orgUri = await getOrganizationUri();
    const response = await fetch(
      `https://api.calendly.com/organization_memberships?organization=${encodeURIComponent(
        orgUri
      )}&email=${encodeURIComponent(email)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${AppEnvs.NEXT_PUBLIC_CALENDLY_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Error fetching membership UUID: ${response.statusText}`);
    }

    const data = await response.json();
    const membership = data.collection[0]; // Assuming the first entry is the required one

    return membership.uri.split("/").pop();
  } catch (error) {
    console.error("Error fetching membership UUID", error);
    throw error;
  }
}

export async function removeProfessorFromOrganization(professorId: number) {
  try {
    // Step 1: Fetch the professor from the database to get their email or UUID
    const professor = await professorRepo.getById(professorId);
    if (!professor) throw new Error("Professor not found");

    // Step 2: Fetch the organization membership UUID from Calendly
    const membershipUuid = await fetchMembershipUuid(professor.email);
    console.log("uuid:......................:", membershipUuid);

    // Step 3: Call the Calendly API to remove the professor from the organization
    const response = await fetch(
      `https://api.calendly.com/organization_memberships/${membershipUuid}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${process.env.NEXT_PUBLIC_CALENDLY_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to remove professor from organization:`);
    }

    // Step 4: After successful deletion, remove the professor from the database
    const deletedProfessor = await professorRepo.delete(professorId);

    return {
      success: true,
      message: "Professor successfully removed from organization and database",
      deletedProfessor,
    };
  } catch (error: any) {
    console.error("Error removing professor:", error);
    return {
      success: false,
      error: error.message || "Failed to remove professor",
    };
  } finally {
    revalidatePath("/admin/professors");
  }
}

export async function updateUserWallet(id: number, amount: number) {
  try {
    await memberRepo.updateWallet(id, amount);

    return { success: "Wallet updated successfully" };
  } catch (error) {
    return { error: "Facing issue,failed to update wallet" };
  }
}

export async function registerUser(prevState: any, formData: FormData) {
  const user: IMemberBase = {
    name: formData.get("name") as string,
    age: Number(formData.get("age")),
    email: formData.get("email") as string,
    address: formData.get("address") as string,
    password: formData.get("password") as string,
    role: "user",
    wallet: 0,
  };

  try {
    const validatedUser: IMemberBase = MemberBaseSchema.parse(user);
    const userInDatabase = await memberRepo.getByEmail(validatedUser.email);
    if (userInDatabase && userInDatabase.email === validatedUser.email) {
      throw new Error("User already exists");
    }
    const hashedPassword = await hashPassword(validatedUser.password);
    const validatedUserWithHashedPassword: IMemberBase = {
      ...validatedUser,
      password: hashedPassword,
    };
    console.log(validatedUserWithHashedPassword);
    const response = await memberRepo.create(
      validatedUserWithHashedPassword as IMemberBase
    );
    console.log(response);

    if (!response) {
      throw new Error("Registration failed");
    }

    return { success: true };
  } catch (error) {
    if (error instanceof ZodError) {
      return { error: error.errors[0].message || "Invalid input" };
    } else if ((error as Error).message) {
      return { error: `${(error as Error).message}` };
    }

    return { error: "An unexpected error occurred" };
  }
}

export async function fetchBooks(
  params: IPageRequest
): Promise<IPagedResponse<IBook>> {
  try {
    const result = await bookRepo.list(params);
    if (!result) {
      throw new Error("No books returned from repository");
    }
    revalidatePath("/user/books");

    return result;
  } catch (error) {
    console.error("Error fetching books:", error);
    throw new Error("Failed to fetch books");
  } finally {
  }
}

export async function fetchUserSpecificBooks(
  params: IPageRequest
): Promise<IPagedResponse<IBook>> {
  try {
    const currentUser = await getUserDetails();
    if (!currentUser) {
      throw new Error("User does not exist");
    }
    const result = await memberRepo.listBooks(currentUser.id, params);
    if (!result) {
      throw new Error("No books returned from repository");
    }
    return result;
  } catch (error) {
    console.error("Error fetching books:", error);
    throw new Error("Failed to fetch books");
  }
}

export async function fetchMembers(
  params: IPageRequest
): Promise<IPagedResponse<IMember>> {
  try {
    const result = await memberRepo.list(params);
    if (!result) {
      throw new Error("No member returned from repository");
    }
    return result;
  } catch (err) {
    console.error("Error in fetching member", error);
    throw new Error("Falid to fetch members");
  }
}
export async function fetchRequests(params: IPageRequest) {
  try {
    const result = await transactionRepo.listRequests(params);
    if (!result) {
      throw new Error("No transaction returned from repository");
    } else {
      return result;
    }
  } catch (error) {
    console.error("Error in listing transaction", error);
  }
}

export async function fetchNonPendingTransactions(params: IPageRequest) {
  try {
    const result = await transactionRepo.listNonPendingTransactions(params);
    if (!result) {
      throw new Error("No transaction returned from repository");
    } else {
      return result;
    }
  } catch (error) {
    console.error("Error in listing transaction", error);
  }
}

export async function fetchMemberSpecificBookRequestsWithStatus(
  memberId: number
) {
  try {
    const result = await transactionRepo.listMemberSpecificRequestedBooks(
      memberId
    );
    return result;
  } catch (error) {
    console.error((error as Error).message);
  }
}

export async function fetchProfessorsList(params: IPageRequest) {
  try {
    const result = await professorRepo.list(params);
    if (!result) {
      throw new Error("No member returned from repository");
    }
    return result;
  } catch (err) {
    console.error("Error in fetching member", error);
    throw new Error("Falid to fetch members");
  } finally {
    revalidatePath("/admin/professors");
  }
}

export async function fetchDueTransactions(params: IPageRequest) {
  try {
    const result = await transactionRepo.listOverdueTransactions(params);
    if (!result) {
      throw new Error("No due transactions returned from repository");
    }
    return result;
  } catch (error) {
    console.error("Error in fetching due transactions", error);
  }
}

export async function fetchAllProfessors() {
  try {
    const professors = await professorRepo.getAll();
    return professors;
  } catch (error) {
    console.error("error occured while fetching all professors:", error);
  }
}

export async function updateBook(
  id: number,
  prevState: any,
  formData: FormData
) {
  const book: IBookBase = {
    title: formData.get("title") as string,
    author: formData.get("author") as string,
    publisher: formData.get("publisher") as string,
    genre: formData.get("genre") as string,
    isbnNo: formData.get("isbnNo") as string,
    numOfPages: Number(formData.get("numOfPages")),
    totalNumOfCopies: Number(formData.get("totalNumOfCopies")),
    price: Number(formData.get("price")),
    imageURL: formData.get("imageUrl")
      ? (formData.get("imageUrl") as string)
      : "",
  };
  try {
    const response = await bookRepo.update(id, book);

    if (!response) {
      return {
        error: "Error:Failed to update book",
      };
    }
  } catch (error) {
    if (error instanceof ZodError) {
      return { error: error.errors[0].message || "Invalid input" };
    } else if ((error as Error).message) {
      return { error: `${(error as Error).message}` };
    }

    return { error: "An unexpected error occurred" };
  }
  revalidatePath(`/admin/books`);
  redirect("/admin/books");
}

export async function updateMember(
  id: number,
  prevState: any,
  formData: FormData
) {
  try {
    let newPassword;
    const user = await memberRepo.getByEmail(formData.get("email") as string);
    if (!formData.get("password")) {
      newPassword = user?.password;
    } else {
      newPassword = await hashPassword(formData.get("password") as string);
    }
    if (!user) {
      throw new Error("The selected user does'nt exist in database");
    }

    const member: IMemberBase = {
      name: formData.get("name") as string,
      age: Number(formData.get("age")),
      email: formData.get("email") as string,
      address: formData.get("address") as string,
      password: newPassword!,
      role: "user",
      wallet: user?.wallet,
    };
    const response = await memberRepo.update(id, member);

    if (!response) {
      return {
        error: "Error: Failed to update member",
      };
    }
  } catch (error) {
    if (error instanceof ZodError) {
      return { error: error.errors[0].message || "Invalid input" };
    } else if ((error as Error).message) {
      return { error: `${(error as Error).message}` };
    }

    return { error: "An unexpected error occurred" };
  }
  revalidatePath(`/admin/members`);
  redirect("/admin/members");
}

export async function deleteBook(id: number) {
  try {
    const deletedBook = await bookRepo.delete(id);
    if (!deleteBook) {
      throw new Error("failed to delete book");
    }
    revalidatePath("/admin/books");
  } catch (error) {
    console.error(error);
  } finally {
    redirect("/admin/books");
  }
}

export async function deleteMember(id: number) {
  try {
    const deletedMember = await memberRepo.delete(id);
    if (!deletedMember) {
      throw new Error("failed to delete member");
    }
    revalidatePath("/admin/members");
  } catch (error) {
    console.error(error);
  } finally {
    redirect("/admin/members");
  }
}

export async function deleteTransaction(id: number) {
  try {
    const deletedMember = await transactionRepo.delete(id);
    if (!deletedMember) {
      throw new Error("failed to delete transaction");
    }
    revalidatePath("/admin/transactions");
  } catch (error) {
    console.error(error);
  } finally {
    redirect("/admin/transactions");
  }
}

export async function createBook(prevState: any, formData: FormData) {
  try {
    console.log("the url received through form data", formData.get("imageUrl"));
    console.log(
      "the price value recieved through form data is",
      formData.get("price")
    );
    const book: IBookBase = {
      title: formData.get("title") as string,
      author: formData.get("author") as string,
      publisher: formData.get("publisher") as string,
      genre: formData.get("genre") as string,
      isbnNo: formData.get("isbnNo") as string,
      numOfPages: Number(formData.get("numOfPages")),
      totalNumOfCopies: Number(formData.get("totalNumOfCopies")),
      price: Number(formData.get("price")),
      imageURL: formData.get("imageUrl") as string,
    };

    const response = await bookRepo.create(book);
    if (!response) {
      throw new Error("Failed to create book");
    }
  } catch (error) {
    if (error instanceof ZodError) {
      return { error: error.errors[0].message || "Invalid input" };
    } else if ((error as Error).message) {
      return { error: `${(error as Error).message}` };
    }

    return { error: "An unexpected error occurred" };
  } finally {
    redirect("/admin/books");
  }
}

export async function createMember(prevState: any, formData: FormData) {
  try {
    const member: IMemberBase = {
      name: formData.get("name") as string,
      age: Number(formData.get("age")),
      email: formData.get("email") as string,
      address: formData.get("address") as string,
      password: await hashPassword(formData.get("password") as string),
      role: formData.get("role") as "admin" | "user",
      wallet: 0,
    };

    const response = await memberRepo.create(member);
    if (!response) {
      throw new Error("failed to create member");
    }
    return { success: true };
  } catch (error) {
    if (error instanceof ZodError) {
      return { error: error.errors[0].message || "Invalid input" };
    } else if ((error as Error).message) {
      return { error: `${(error as Error).message}` };
    }

    return { error: "An unexpected error occurred" };
  }
}

export async function createProfessor(prevState: any, formData: FormData) {
  try {
    const professorData = {
      name: formData.get("name"),
      email: formData.get("email"),
      department: formData.get("department"),
      bio: formData.get("bio"),
      calendlyLink: formData.get("calendlyLink"),
    };

    // Validate the input data
    const validatedData = ProfessorBaseSchema.parse(professorData);

    const professor: IProfessorBase = {
      name: validatedData.name,
      email: validatedData.email,
      department: validatedData.department,
      bio: validatedData.bio,
      calendlyLink: validatedData.calendlyLink,
      wallet: 0,
    };

    const response = await professorRepo.create(professor);
    if (!response) {
      throw new Error("Failed to create professor");
    }
    return { success: true };
  } catch (error) {
    if (error instanceof ZodError) {
      return { error: error.errors[0].message || "Invalid input" };
    } else if (error instanceof Error) {
      return { error: error.message };
    }

    return { error: "An unexpected error occurred" };
  }
}

export async function getBookById(id: number) {
  try {
    return await bookRepo.getById(id);
  } catch (err) {
    console.error("unexpected error occured");
  }
}

export async function getMemberById(id: number) {
  try {
    const member = await memberRepo.getById(id);
    if (!member) {
      throw new Error("failed to fetch member");
    }
    return member;
  } catch (err) {
    console.error("an unexpected error occured");
  }
}

export async function getUserDetails() {
  const session = await auth();
  const user = session?.user;
  const email = user?.email;
  try {
    const userDetails = await memberRepo.getByEmail(email as string);
    if (!userDetails) {
      throw new Error("User details not be found");
    }
    return userDetails;
  } catch (error) {
    console.error("Error finding details of user", error);
  }
}

export async function createBookRequest(id: number) {
  try {
    const user = await getUserDetails();
    if (!user) {
      return { error: "failed to fetch user details" };
    }
    const transactionData: ITransactionBase = {
      memberId: BigInt(user?.id),
      bookId: BigInt(id),
    };
    const response = await transactionRepo.create(transactionData);

    return { success: true };
  } catch (error) {
    console.error(error);
    return {
      error: (error as Error).message,
    };
  } finally {
    revalidatePath("/admin/books");
    revalidatePath("/admin/requests");
  }
}

export async function approveRequest(id: number) {
  try {
    const response = await transactionRepo.updateStatus(id, "issued");
    if (!response) {
      return { error: "Failed to approve request" };
    }
    revalidatePath("/admin/requests");
    return { success: true };
  } catch (error) {
    console.error(error);
    return {
      error: (error as Error).message,
    };
  }
}

export async function rejectRequest(id: number) {
  try {
    const response = await transactionRepo.updateStatus(id, "rejected");
    if (!response) {
      return { error: "Failed to reject request" };
    }
    revalidatePath("/admin/requests");
    return { success: true };
  } catch (error) {
    console.error(error);
    return {
      error: (error as Error).message,
    };
  }
}

export async function returnRequest(id: number) {
  try {
    const response = await transactionRepo.updateStatus(id, "returned");
    if (!response) {
      return { error: "Failed to return book" };
    }
    revalidatePath("/admin/return-book");
    return { success: true };
  } catch (error) {
    console.error(error);
    return {
      error: (error as Error).message,
    };
  }
}
export async function switchUserRoles(id: number, role: string) {
  try {
    const user = await memberRepo.getById(id);
    let updatedUser: IMemberBase | undefined;
    const updatedRole = role === "admin" ? "user" : "admin";
    if (!user) {
      return { error: "Failed to fetch user while changing role" };
    } else {
      updatedUser = {
        name: user?.name,
        address: user.address,
        email: user.email,
        age: user.age,
        password: user.password,
        role: updatedRole,
        wallet: user.wallet,
      };
    }
    const result = await memberRepo.update(id, updatedUser);
    if (!result) {
      return { error: "Failed to update the role" };
    }
    return { success: `role switched for user ${result.name}` };
  } catch (error) {
    return { error: "Failed to update the role" };
  } finally {
    revalidatePath("/admin/members/");
  }
}

export async function updateProfessor(data: {
  id: number;
  name: string;
  department?: string | null;
  bio?: string | null;
}) {
  try {
    const professor = await professorRepo.getById(data.id);
    if (!professor) {
      return {
        success: false,
        error: "Failed to fetch professor details while updating",
      };
    }
    const updatedProfessor = await professorRepo.update(data.id, {
      ...professor,
      name: data.name,
      department: data.department,
      bio: data.bio,
    });

    return {
      success: true,
      error: "",
    };
  } catch (error) {
    console.error("Failed to update professor", error);
    return {
      success: false,
      error: (error as Error).message || "Failed to update professor",
    };
  }
}
